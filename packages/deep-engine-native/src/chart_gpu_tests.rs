//! C03 real-GPU proof: a ChartIR rendered by `render_chart` flows through
//! the production `Deep2dGpuPainter` (same device/queue as the 3D pass) and
//! lands actual pixels — line geometry reads back at the expected screen
//! positions, and an empty series paints nothing.

use deep_engine_native::chart::{
    ChartAxis, ChartAxisChannel, ChartDataset, ChartIR, ChartScale, ChartSeries, ChartSeriesType,
    render_chart,
};
use deep_engine_native::deep2d::{Deep2dRuntimeContent, validate_display_list};

use crate::deep2d_gpu::Deep2dGpuPainter;
use crate::deep2d_gpu_cache::Deep2dGpuAssetCache;

const WIDTH: u32 = 128;
const HEIGHT: u32 = 64;

#[path = "chart_heatmap_gpu_tests.rs"]
mod heatmap;
#[path = "chart_incremental_gpu_tests.rs"]
mod incremental;
#[path = "chart_state_gpu_tests.rs"]
mod state;
#[cfg(target_os = "windows")]
#[path = "text_raster_gpu_tests.rs"]
mod text_raster;
#[path = "deep2d_vertex_transfer_gpu_tests.rs"]
mod vertex_transfer;

fn line_ir(rows: Vec<(f64, f64)>) -> ChartIR {
    ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "gpu-line".into(),
        datasets: vec![ChartDataset {
            id: "d".into(),
            dimensions: vec!["x".into(), "y".into()],
            rows: rows
                .into_iter()
                .map(|(x, y)| vec![serde_json::json!(x), serde_json::json!(y)])
                .collect(),
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
            id: "line".into(),
            label: "trend".into(),
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

async fn gpu_context() -> (wgpu::Device, wgpu::Queue, wgpu::Adapter) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .expect("real GPU adapter");
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .unwrap();
    (device, queue, adapter)
}

fn draw_to_pixels(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &Deep2dRuntimeContent,
) -> Result<Vec<[u8; 4]>, String> {
    let cache = std::sync::Arc::new(Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        device,
        queue,
        wgpu::TextureFormat::Rgba8Unorm,
        content,
        &cache,
    )
    .expect("chart display list must pass the production painter");
    draw_painter_to_pixels(device, queue, &painter)
}

fn draw_painter_to_pixels(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    painter: &Deep2dGpuPainter,
) -> Result<Vec<[u8; 4]>, String> {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("chart gpu target"),
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
        label: Some("chart gpu readback"),
        size: (WIDTH * HEIGHT * 4) as u64,
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
    let view = readback
        .get_mapped_range(..)
        .map_err(|error| format!("chart readback map failed: {error}"))?;
    let pixels = view
        .chunks_exact(4)
        .map(|chunk| [chunk[0], chunk[1], chunk[2], chunk[3]])
        .collect();
    drop(view);
    readback.unmap();
    Ok(pixels)
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_zoom_changes_pixels_and_clips_to_plot() {
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let ir = line_ir(vec![(0.0, 0.0), (1.0, 1.0)]);
        let mut state = deep_engine_native::chart::InteractionState::from_ir(&ir).unwrap();
        let mut captures = Vec::new();
        for step in 0..3 {
            if step == 1 {
                state
                    .apply(
                        &ir,
                        deep_engine_native::chart::ChartAction::Zoom {
                            axis_id: "x".into(),
                            start: 0.25,
                            end: 0.75,
                        },
                    )
                    .unwrap();
            } else if step == 2 {
                state
                    .apply(&ir, deep_engine_native::chart::ChartAction::ResetZoom)
                    .unwrap();
            }
            let list = deep_engine_native::chart::render_chart_with_windows(
                &ir,
                WIDTH.into(),
                HEIGHT.into(),
                &state.hidden_series,
                &state.zoom_windows,
            )
            .unwrap();
            captures.push(
                draw_to_pixels(&device, &queue, &Deep2dRuntimeContent::DisplayList(list)).unwrap(),
            );
        }
        assert_ne!(captures[0], captures[1]);
        assert_eq!(captures[0], captures[2]);
        assert!(captures[1].iter().any(|pixel| pixel[3] > 0));
        for (index, pixel) in captures[1].iter().enumerate() {
            let (x, y) = (index % WIDTH as usize, index / WIDTH as usize);
            if !(8..120).contains(&x) || !(32..56).contains(&y) {
                assert_eq!(pixel[3], 0, "outside plot at {x},{y}");
            }
        }
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_legend_toggle_removes_and_restores_series_pixels() {
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let ir = line_ir(vec![(0.0, 0.0), (1.0, 1.0)]);
        let mut state = deep_engine_native::chart::InteractionState::from_ir(&ir).unwrap();
        let mut captures = Vec::new();
        for step in 0..3 {
            if step > 0 {
                state
                    .apply(
                        &ir,
                        deep_engine_native::chart::ChartAction::ToggleLegend {
                            series_id: ir.series[0].id.clone(),
                        },
                    )
                    .unwrap();
            }
            let list = deep_engine_native::chart::render_chart_with_hidden_series(
                &ir,
                WIDTH.into(),
                HEIGHT.into(),
                &state.hidden_series,
            )
            .unwrap();
            captures.push(
                draw_to_pixels(&device, &queue, &Deep2dRuntimeContent::DisplayList(list)).unwrap(),
            );
        }
        assert!(captures[0].iter().any(|pixel| pixel[3] > 0));
        assert!(captures[1].iter().all(|pixel| pixel[3] == 0));
        assert_eq!(captures[0], captures[2]);
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_chart_render_flows_through_deep2d_painter_to_real_pixels() {
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        let info = adapter.get_info();
        assert_ne!(info.device_type, wgpu::DeviceType::Cpu, "software adapter");

        // Rising line across the plot: the series color is the line blue.
        let ir = line_ir(vec![(0.0, 0.0), (1.0, 1.0)]);
        let display_list =
            render_chart(&ir, f64::from(WIDTH), f64::from(HEIGHT)).expect("chart renders");
        let validation = validate_display_list(&display_list);
        assert!(validation.valid, "{:?}", validation.issues);
        let pixels = draw_to_pixels(
            &device,
            &queue,
            &Deep2dRuntimeContent::DisplayList(display_list),
        )
        .expect("draw+readback");

        let painted = pixels.iter().filter(|pixel| pixel[3] > 0).count();
        assert!(
            painted > 50,
            "line series must paint a visible polyline, painted={painted}"
        );
        // Line color is [0.2, 0.6, 1.0]: find at least one pixel close to it.
        let line_pixel = pixels
            .iter()
            .any(|pixel| pixel[0] > 20 && pixel[0] < 120 && pixel[1] > 100 && pixel[2] > 200);
        assert!(line_pixel, "series color must appear in the readback");
        println!(
            "chart GPU OK: adapter={:?} painted_pixels={painted}/{}/{}",
            info.name,
            pixels.len(),
            WIDTH * HEIGHT
        );
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_empty_chart_series_paints_nothing_and_stays_valid() {
    pollster::block_on(async {
        let (device, queue, _) = gpu_context().await;
        let ir = line_ir(Vec::new());
        let display_list =
            render_chart(&ir, f64::from(WIDTH), f64::from(HEIGHT)).expect("empty chart renders");
        assert!(
            validate_display_list(&display_list).valid,
            "empty series display list stays contract-valid"
        );
        let pixels = draw_to_pixels(
            &device,
            &queue,
            &Deep2dRuntimeContent::DisplayList(display_list),
        )
        .expect("draw+readback");
        assert!(
            pixels.iter().all(|pixel| pixel[3] == 0),
            "empty series must paint zero pixels"
        );
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_chart_render_matches_cpu_reference_rasterizer() {
    // D09: same fixture through the CPU reference rasterizer and the real
    // GPU painter; interior pixels must agree within blend rounding, edge
    // band divergence is legal (antialiasing), and the report is printed.
    pollster::block_on(async {
        let (device, queue, _) = gpu_context().await;
        // Dense series (>480 points) renders as the min-max envelope FILL:
        // the only line geometry the CPU reference can reproduce exactly
        // (stroke outlines of noisy polylines self-intersect by nature).
        let dense_rows = (0..5000)
            .map(|i| {
                (
                    i as f64,
                    ((i as f64) * 0.37).sin() * 0.4 + 0.5 + ((i as f64) * 0.011).cos() * 0.3,
                )
            })
            .collect();
        let ir = line_ir(dense_rows);
        let display_list = render_chart(&ir, 128.0, 64.0).expect("chart renders");
        assert!(validate_display_list(&display_list).valid);

        // GPU path.
        let cache = std::sync::Arc::new(Deep2dGpuAssetCache::new());
        let painter = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &Deep2dRuntimeContent::DisplayList(display_list.clone()),
            &cache,
        )
        .expect("painter accepts chart");
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("d09 gpu target"),
            size: wgpu::Extent3d {
                width: 128,
                height: 64,
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
        painter.draw(&mut encoder, &view, (128, 64));
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("d09 readback"),
            size: 128 * 64 * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(128 * 4),
                    rows_per_image: Some(64),
                },
            },
            wgpu::Extent3d {
                width: 128,
                height: 64,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        readback.map_async(wgpu::MapMode::Read, .., |result| {
            result.expect("map");
        });
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let mapped = readback
            .get_mapped_range(..)
            .map_err(|error| format!("map: {error}"))
            .unwrap();
        let gpu_pixels: Vec<[u8; 4]> = mapped
            .chunks_exact(4)
            .map(|chunk| [chunk[0], chunk[1], chunk[2], chunk[3]])
            .collect();
        drop(mapped);
        readback.unmap();

        // CPU reference: triangulate the same chart geometry. The chart line
        // is one stroke; for the reference we rasterize the envelope fill
        // path semantics — reconstruct triangles from the display list's
        // path resources is the painter's tessellation job, so the
        // reference uses the same envelope the renderer emitted (dense-line
        // fixtures) or skips stroke-only geometry, counted as edge band.
        // For this fixture the envelope fill covers the series body.
        let mapping =
            deep_engine_native::deep2d::LetterboxMapping::new([128.0, 64.0], [128.0, 64.0]);
        let _ = mapping; // identity here; mapping parity is asserted in unit tests
        let mut triangles = Vec::new();
        for resource in &display_list.resources {
            if let deep_engine_native::deep2d::Deep2dResource::Path(path) = resource {
                // Fan-triangulate closed fills only (stroke-only fixtures
                // have no CPU reference and are reported as edge band).
                let mut points: Vec<[f64; 2]> = Vec::new();
                let mut closed = false;
                for verb in &path.verbs {
                    match verb {
                        deep_engine_native::deep2d::Deep2dPathVerb::Move { x, y } => {
                            points.push([*x, *y]);
                        }
                        deep_engine_native::deep2d::Deep2dPathVerb::Line { x, y } => {
                            points.push([*x, *y]);
                        }
                        deep_engine_native::deep2d::Deep2dPathVerb::Close => closed = true,
                        _ => {}
                    }
                }
                if closed && points.len() >= 3 {
                    // The dense-line envelope is two x-monotone chains
                    // (mins left→right, maxs right→left): triangulate as a
                    // strip, which is exact for this shape. Fallback to fan
                    // only for non-envelope (convex/small) fills.
                    let half = points.len() / 2;
                    if points.len().is_multiple_of(2)
                        && half >= 2
                        && points[..half].windows(2).all(|w| w[0][0] <= w[1][0])
                        && points[half..].windows(2).all(|w| w[0][0] >= w[1][0])
                    {
                        let mins = &points[..half];
                        let maxs = &points[half..]; // reversed maxs
                        for index in 0..half - 1 {
                            triangles.push(deep_engine_native::deep2d::ReferenceTriangle {
                                vertices: [mins[index], mins[index + 1], maxs[index + 1]],
                                color: [0.2, 0.6, 1.0, 1.0],
                            });
                            triangles.push(deep_engine_native::deep2d::ReferenceTriangle {
                                vertices: [mins[index], maxs[index + 1], maxs[index]],
                                color: [0.2, 0.6, 1.0, 1.0],
                            });
                        }
                    } else {
                        for index in 2..points.len() {
                            triangles.push(deep_engine_native::deep2d::ReferenceTriangle {
                                vertices: [points[0], points[index - 1], points[index]],
                                color: [0.2, 0.6, 1.0, 1.0],
                            });
                        }
                    }
                }
            }
        }
        let reference = deep_engine_native::deep2d::rasterize(128, 64, &triangles);
        let report = deep_engine_native::deep2d::compare(&reference, &gpu_pixels, 128, 64, 8);
        println!(
            "D09 pixel comparison: total={} exact={} near={} edge_band={} divergent={} interior_agreement={:.4}",
            report.total_pixels,
            report.exact_matches,
            report.near_matches,
            report.edge_band,
            report.divergent,
            report.interior_agreement_ratio()
        );
        assert!(
            report.interior_agreement_ratio() >= 0.98,
            "interior agreement below 98%: {report:?}"
        );
    });
}
