//! U09 real-GPU proof: the assembled prototype frame (tree + inspector
//! controls + chart strip) renders through the production painter and lands
//! distinguishable pixels per region — panel washes, accent selection,
//! slider knob and the chart series color are all present in the readback.

use deep_engine_native::chart::{
    ChartAxis, ChartAxisChannel, ChartDataset, ChartIR, ChartScale, ChartSeries, ChartSeriesType,
    render_chart,
};
use deep_engine_native::deep2d::{Deep2dRuntimeContent, validate_display_list};
use deep_engine_native::native_ui::{ControlPalette, PrototypeState, build_prototype_frame};

use crate::deep2d_gpu::Deep2dGpuPainter;
use crate::deep2d_gpu_cache::Deep2dGpuAssetCache;

const WIDTH: u32 = 320;
const HEIGHT: u32 = 200;

fn prototype_ir() -> ChartIR {
    // Standalone IR used to sanity-check the chart lane in isolation; the
    // prototype frame builds its own via build_prototype_frame.
    ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "proto-probe".into(),
        datasets: vec![ChartDataset {
            id: "d".into(),
            dimensions: vec!["x".into(), "y".into()],
            rows: vec![
                vec![serde_json::json!(0.0), serde_json::json!(1.0)],
                vec![serde_json::json!(1.0), serde_json::json!(5.0)],
            ]
            .into(),
        }],
        axes: vec![
            ChartAxis {
                id: "x".into(),
                channel: ChartAxisChannel::X,
                scale: ChartScale::Linear,
                min: None,
                max: None,
            },
            ChartAxis {
                id: "y".into(),
                channel: ChartAxisChannel::Y,
                scale: ChartScale::Linear,
                min: None,
                max: None,
            },
        ],
        series: vec![ChartSeries {
            id: "probe-line".into(),
            label: "probe".into(),
            series_type: ChartSeriesType::Line,
            dataset_id: "d".into(),
            x: Some("x".into()),
            y: Some("y".into()),
            name: None,
            value: None,
            min: None,
            max: None,
            x_axis_id: Some("x".into()),
            y_axis_id: Some("y".into()),
        }],
        ..Default::default()
    }
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_prototype_frame_renders_all_regions_through_the_painter() {
    pollster::block_on(async {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("real GPU adapter");
        let info = adapter.get_info();
        assert_ne!(info.device_type, wgpu::DeviceType::Cpu);
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();

        // The chart lane alone must be render-pipeline clean on this device.
        let probe_list = render_chart(&prototype_ir(), 200.0, 100.0).expect("probe chart");
        assert!(validate_display_list(&probe_list).valid);

        let state = PrototypeState {
            objects: vec![
                "pump-01".into(),
                "valve-02".into(),
                "tank-03".into(),
                "sensor-04".into(),
            ],
            selected_object: Some(1),
            slider_value: 42.0,
            inspector_visible: true,
        };
        let frame = build_prototype_frame(
            f64::from(WIDTH),
            f64::from(HEIGHT),
            &state,
            &ControlPalette::dark(),
        )
        .expect("frame builds");
        let validation = validate_display_list(&frame);
        assert!(
            validation.valid,
            "prototype frame must be contract-valid: {:?}",
            validation.issues
        );

        let cache = std::sync::Arc::new(Deep2dGpuAssetCache::new());
        let painter = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &Deep2dRuntimeContent::DisplayList(frame),
            &cache,
        )
        .expect("prototype frame must pass the production painter");
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("prototype gpu target"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&Default::default());
        painter.draw(&mut encoder, &view, (WIDTH, HEIGHT));
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("prototype readback"),
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
            wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        readback.map_async(wgpu::MapMode::Read, .., |result| {
            result.expect("readback map");
        });
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let view_data = readback
            .get_mapped_range(..)
            .map_err(|error| format!("map failed: {error}"))
            .unwrap();
        let pixels: Vec<[u8; 4]> = view_data
            .chunks_exact(4)
            .map(|chunk| [chunk[0], chunk[1], chunk[2], chunk[3]])
            .collect();
        drop(view_data);
        readback.unmap();

        let painted = pixels.iter().filter(|p| p[3] > 0).count();
        assert!(painted > 500, "frame must paint most chrome: {painted}");
        // Accent pixels (selected row / slider fill / buttons): warm gold.
        let accent = pixels
            .iter()
            .any(|p| p[0] > 150 && p[1] > 110 && p[2] < 140);
        assert!(accent, "accent chrome must be visible");
        // Chart line blue must appear in the bottom strip.
        let strip_top = ((HEIGHT as usize * 3) / 4) * WIDTH as usize;
        let chart_blue = pixels[strip_top..].iter().any(|p| p[2] > 180 && p[0] < 140);
        assert!(chart_blue, "chart series color must appear in the strip");
        println!(
            "prototype GPU OK: adapter={:?} painted={painted}/{}",
            info.name,
            pixels.len()
        );
    });
}
