//! C05 real-GPU benchmark: one million decoded points go through the
//! chunked channel, decimate to the drawn budget, render through the
//! production painter and read back — with an honest timing report (input /
//! resident / visible / drawn / dropped + wall clock per stage).

use std::time::Instant;

use deep_engine_native::chart::{
    CHART_BUDGETS, CHUNK_SIZE, ChannelAccounting, ChartAxis, ChartAxisChannel, ChartDataset,
    ChartIR, ChartScale, ChartSeries, ChartSeriesType, Decimation, MAX_RESIDENT_POINTS,
    render_chart,
};
use deep_engine_native::deep2d::{Deep2dCommand, Deep2dRuntimeContent, validate_display_list};

use crate::deep2d_gpu::Deep2dGpuPainter;
use crate::deep2d_gpu_cache::Deep2dGpuAssetCache;

/// Draw budget per frame: 100k vertices keeps the decode+render path inside
/// one frame on the reference GPU while proving the sampling contract.
const DRAW_BUDGET: usize = 100_000;

fn million_point_ir(y_channel: Vec<f64>) -> ChartIR {
    // The IR row budget (500k JSON rows) is the *source* document budget;
    // the GPU benchmark channel decodes 1M numeric points from a generated
    // signal, so the dataset here references (not stores) those points via
    // a decimated JSON sample — exactly how a real client pages data.
    let sample_stride = y_channel.len() / CHART_BUDGETS.rows.min(y_channel.len());
    let rows = y_channel
        .iter()
        .enumerate()
        .step_by(sample_stride.max(1))
        .take(CHART_BUDGETS.rows)
        .map(|(index, value)| vec![serde_json::json!(index as f64), serde_json::json!(value)])
        .collect::<Vec<_>>();
    ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "million-points".into(),
        datasets: vec![ChartDataset {
            id: "d".into(),
            dimensions: vec!["x".into(), "y".into()],
            rows: rows.into(),
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
            id: "signal".into(),
            label: "signal".into(),
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
fn nvidia_million_point_channel_meets_the_benchmark_contract() {
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

        // Stage 1: generate + decode 1M points into the chunked channel.
        let generate_start = Instant::now();
        let mut channel = deep_engine_native::chart::ChunkedSeries::with_chunk_size(CHUNK_SIZE);
        let chunk = (0..CHUNK_SIZE)
            .map(|i| ((i % 4096) as f64 * 0.001).sin())
            .collect::<Vec<_>>();
        while channel.len() + chunk.len() <= MAX_RESIDENT_POINTS {
            channel.append(&chunk).expect("within budget");
        }
        let decode_elapsed = generate_start.elapsed();
        assert_eq!(channel.len(), MAX_RESIDENT_POINTS);

        // Stage 2: viewport slice + decimation to the draw budget.
        let slice_start = Instant::now();
        let visible = channel.visible_slice(0, MAX_RESIDENT_POINTS);
        let (drawn, accounting) = decimate_report(&channel, &visible, DRAW_BUDGET);
        let decimate_elapsed = slice_start.elapsed();
        assert_eq!(drawn.len(), DRAW_BUDGET);
        assert_eq!(accounting.decimation, Decimation::EqualStrideFirstLast);

        // Stage 3: build an IR from the drawn window and render + GPU submit.
        let render_start = Instant::now();
        let ir = million_point_ir(drawn.clone());
        let display_list = render_chart(&ir, 1280.0, 720.0).expect("renders");
        assert!(validate_display_list(&display_list).valid);
        let vertices = display_list
            .commands
            .iter()
            .filter_map(|command| match command {
                Deep2dCommand::Path(path) => Some(path.id.as_str()),
                _ => None,
            })
            .count();
        let render_elapsed = render_start.elapsed();

        let cache = std::sync::Arc::new(Deep2dGpuAssetCache::new());
        let gpu_start = Instant::now();
        let painter = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &Deep2dRuntimeContent::DisplayList(display_list),
            &cache,
        )
        .expect("million-point display list must pass the painter");
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("million point target"),
            size: wgpu::Extent3d {
                width: 640,
                height: 360,
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
        painter.draw(&mut encoder, &view, (640, 360));
        queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let gpu_elapsed = gpu_start.elapsed();
        drop(painter);

        println!(
            "million-point GPU benchmark: adapter={:?} input={} resident={} visible={} drawn={} dropped={} rule={:?} decode={:?} slice+decimate={:?} render={:?} gpu_prepare+draw={:?} path_commands={vertices}",
            info.name,
            accounting.input_points,
            accounting.resident_points,
            accounting.visible_points,
            accounting.drawn_points,
            accounting.dropped_points,
            accounting.decimation,
            decode_elapsed,
            decimate_elapsed,
            render_elapsed,
            gpu_elapsed,
        );
        // Contract: decode+decimate must stay interactive for the channel
        // (the GPU submit is measured but not throttled — driver dependent).
        assert!(
            decode_elapsed.as_secs_f64() < 5.0 && decimate_elapsed.as_secs_f64() < 5.0,
            "channel pipeline regressed: decode {decode_elapsed:?} decimate {decimate_elapsed:?}"
        );
    });
}

fn decimate_report(
    channel: &deep_engine_native::chart::ChunkedSeries,
    visible: &[f64],
    budget: usize,
) -> (Vec<f64>, ChannelAccounting) {
    channel.decimate(visible, budget)
}
