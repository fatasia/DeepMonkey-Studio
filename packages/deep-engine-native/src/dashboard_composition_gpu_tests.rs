//! Production painter readback for the TypeScript dashboard composition golden.
use super::{Deep2dGpuAssetCache, Deep2dGpuPainter, gpu_context};
use deep_engine_native::{
    chart::{ChartDataMessage, ChartRuntime, DatasetRowsUpdate},
    dashboard_runtime::DashboardRuntime,
    deep2d::Deep2dRuntimeContent,
    runtime_package::parse_and_validate_runtime_package,
};
use std::sync::Arc;
const WIDTH: u32 = 960;
const HEIGHT: u32 = 540;

fn draw(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &Deep2dRuntimeContent,
    cache: &Arc<Deep2dGpuAssetCache>,
) -> Vec<u8> {
    let painter = Deep2dGpuPainter::new(
        device,
        queue,
        wgpu::TextureFormat::Rgba8Unorm,
        content,
        cache,
    )
    .unwrap();
    let size = wgpu::Extent3d {
        width: WIDTH,
        height: HEIGHT,
        depth_or_array_layers: 1,
    };
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dashboard composition readback"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let _clear = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("dashboard test background"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
    }
    painter.draw(&mut encoder, &view, (WIDTH, HEIGHT));
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("dashboard rgba readback"),
        size: u64::from(WIDTH * HEIGHT * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(WIDTH * 4),
                rows_per_image: Some(HEIGHT),
            },
        },
        size,
    );
    queue.submit([encoder.finish()]);
    readback.map_async(wgpu::MapMode::Read, .., |result| {
        result.expect("dashboard readback map")
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let mapped = readback.get_mapped_range(..).unwrap();
    let pixels = mapped.to_vec();
    drop(mapped);
    readback.unmap();
    pixels
}

fn capture(name: &str, pixels: &[u8]) {
    let Some(directory) = std::env::var_os("DEEP_DASHBOARD_CAPTURE_DIR") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("{name}.rgba")), pixels).unwrap();
    let metadata = serde_json::json!({"width":WIDTH,"height":HEIGHT,"format":"rgba8unorm","bytesPerRow":WIDTH*4,"origin":"top-left"});
    std::fs::write(
        directory.join("dimensions.json"),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .unwrap();
}

fn changed_in(before: &[u8], after: &[u8], frame: [f64; 4], page: [f64; 2]) -> usize {
    let scale = (f64::from(WIDTH) / page[0]).min(f64::from(HEIGHT) / page[1]);
    let ox = (f64::from(WIDTH) - page[0] * scale) / 2.;
    let oy = (f64::from(HEIGHT) - page[1] * scale) / 2.;
    let x0 = (ox + frame[0] * scale).floor().max(0.) as u32;
    let y0 = (oy + frame[1] * scale).floor().max(0.) as u32;
    let x1 = (ox + (frame[0] + frame[2]) * scale)
        .ceil()
        .min(f64::from(WIDTH)) as u32;
    let y1 = (oy + (frame[1] + frame[3]) * scale)
        .ceil()
        .min(f64::from(HEIGHT)) as u32;
    (y0..y1)
        .flat_map(|y| (x0..x1).map(move |x| ((y * WIDTH + x) * 4) as usize))
        .filter(|i| before[*i..*i + 4] != after[*i..*i + 4])
        .count()
}
fn update(chart: &ChartRuntime) -> ChartDataMessage {
    let dataset = &chart.source().datasets[0];
    let mut rows: Vec<_> = dataset.rows.iter().cloned().collect();
    rows[0][1] = serde_json::json!(8);
    rows[1][1] = serde_json::json!(0.25);
    ChartDataMessage {
        schema: "deep-engine.chart-data-update".into(),
        schema_version: 1,
        chart_id: chart.source().id.clone(),
        expected_data_revision: chart.data_revision(),
        data_revision: chart.data_revision() + 1,
        datasets: vec![DatasetRowsUpdate::Replace {
            dataset_id: dataset.id.clone(),
            rows,
        }],
    }
}
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn dashboard_golden_updates_only_one_chart_and_restores_pages() {
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let loaded = parse_and_validate_runtime_package(include_bytes!(
            "../../deep-engine/fixtures/dashboard-composition-v1.json"
        ))
        .unwrap()
        .dashboard
        .unwrap();
        let mut runtime = DashboardRuntime::new(loaded).unwrap();
        let page = runtime.document().pages[0].clone();
        let page2 = runtime.document().pages[1].id.clone();
        let nodes: Vec<_> = page.nodes.iter().filter(|n| n.chart.is_some()).collect();
        assert_eq!(nodes.len(), 2);
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let before = draw(&device, &queue, runtime.content(), &cache);
        capture("before", &before);
        assert!(
            before
                .chunks_exact(4)
                .any(|p| p[0] != 0 || p[1] != 0 || p[2] != 0),
            "golden must render visible content"
        );
        let second_revision = runtime.chart(&nodes[1].id).unwrap().data_revision();
        runtime
            .apply_data(&nodes[0].id, update(runtime.chart(&nodes[0].id).unwrap()))
            .unwrap();
        let after = draw(&device, &queue, runtime.content(), &cache);
        capture("after", &after);
        assert!(
            changed_in(&before, &after, nodes[0].frame, [page.width, page.height]) > 100,
            "first chart must change actual pixels"
        );
        assert_eq!(
            changed_in(&before, &after, nodes[1].frame, [page.width, page.height]),
            0,
            "second chart must retain every pixel"
        );
        assert_eq!(
            runtime.chart(&nodes[1].id).unwrap().data_revision(),
            second_revision
        );
        let content = runtime.content().clone();
        let revision = runtime.chart(&nodes[0].id).unwrap().data_revision();
        let mut bad = update(runtime.chart(&nodes[0].id).unwrap());
        bad.expected_data_revision += 10;
        assert!(runtime.apply_data(&nodes[0].id, bad).is_err());
        assert_eq!(runtime.content(), &content);
        assert_eq!(
            runtime.chart(&nodes[0].id).unwrap().data_revision(),
            revision
        );
        assert!(runtime.switch_page("missing-page").is_err());
        assert_eq!(
            draw(&device, &queue, runtime.content(), &cache),
            after,
            "bad CPU candidates preserve rendered pixels"
        );
        runtime.switch_page(&page2).unwrap();
        let second = draw(&device, &queue, runtime.content(), &cache);
        capture("page2", &second);
        assert_ne!(second, after, "second page must render different content");
        runtime.switch_page(&page.id).unwrap();
        let restored = draw(&device, &queue, runtime.content(), &cache);
        capture("restored", &restored);
        assert_eq!(
            restored, after,
            "returning to the page preserves updated charts and text"
        );
        assert!(
            validation.pop().await.is_none(),
            "production painter emitted a GPU validation error"
        );
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn composite_preserves_package_atlas_tint_through_disjoint_clips() {
    use deep_engine_native::deep2d::{
        Deep2dComposite, Deep2dLayer, Deep2dRect, decode_runtime_content,
    };
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let mut source =
            decode_runtime_content(include_bytes!("../fixtures/deep2d_runtime_atlas_v1.json"))
                .unwrap();
        if let Deep2dRuntimeContent::Package(p) = &mut source {
            p.quads[2].color = [0.2, 0.4, 0.6, 0.8];
            p.quads[2].opacity = 0.5;
        }
        let list = source.display_list();
        let size = [list.logical_width, list.logical_height];
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let before = draw(&device, &queue, &source, &cache);
        let layers = (0..2)
            .map(|i| Deep2dLayer {
                id: format!("node.{i}"),
                content: Arc::new(source.clone()),
                translation: [0., 0.],
                clip: Deep2dRect {
                    x: f64::from(i) * size[0] / 2.,
                    y: 0.,
                    width: size[0] / 2.,
                    height: size[1],
                },
            })
            .collect();
        let composite = Deep2dRuntimeContent::Composite(
            Deep2dComposite::new("atlas-page".into(), 1, size, layers).unwrap(),
        );
        let after = draw(&device, &queue, &composite, &cache);
        assert_eq!(
            before, after,
            "two clipped copies must preserve glyph/image tint, opacity, UVs and draw order"
        );
        assert!(
            after
                .chunks_exact(4)
                .any(|p| p[0] != 0 || p[1] != 0 || p[2] != 0)
        );
    });
}
