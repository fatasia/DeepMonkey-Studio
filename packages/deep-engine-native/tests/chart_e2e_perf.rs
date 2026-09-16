//! P1-10 端到端 CPU/GPU 性能基线:真实窗口(Vulkan,1280×720)下 8 系列 × 8192 行
//! 折线图的七类场景。渲染走生产入口 `chart::presentation::present_chart`(几何 +
//! tooltip 文字 + 图例同链路),每帧拆分:CPU prepare(内容变更、栅格化、stage、编码
//! 与提交)、present 延迟(上一帧 present → 本帧 acquire 完成,含 Fifo 排队)、GPU 帧
//! timestamp(设备支持时)、上传字节(renderer 现有 vertex_transfer_stats)与显存峰值
//! 估计(顶点驻留 + 细分缓存 + 后台缓冲;不含图集纹理与管线对象,估计口径偏低)。
//! 单机单卡固定夹具:不含跨设备对比、不含 FPS 结论、显存为估计值。仅 Release 显式运行:
//! cargo test --release --locked --manifest-path packages/deep-engine-native/Cargo.toml
//!   --test chart_e2e_perf -- --ignored --nocapture --test-threads=1
#![allow(dead_code)] // include 的生产模块带有测试环境走不到的观测访问器
#[path = "../src/deep2d_atlas_gpu.rs"]
mod deep2d_atlas_gpu;
#[path = "../src/deep2d_gpu.rs"]
mod deep2d_gpu;
#[path = "../src/deep2d_gpu_cache.rs"]
mod deep2d_gpu_cache;
#[path = "../src/deep2d_scissor.rs"]
mod deep2d_scissor;
use deep_engine_native::chart::{
    ChartAction, ChartDataUpdate, ChartIR, ChartRuntime, DatasetRowsUpdate, parse_chart_ir,
    presentation::present_chart,
};
use deep_engine_native::deep2d::Deep2dRuntimeContent;
use deep2d_gpu::Deep2dGpuPainter;
use serde_json::{Value, json};
use std::time::Instant;
use winit::{dpi::PhysicalSize, platform::windows::EventLoopBuilderExtWindows, window::Window};
const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;
const WARMUP: usize = 5;
const SAMPLES: usize = 30;
const ROWS: usize = 8192;
const TS_SLOTS: usize = 512;
const SLOT_STRIDE: u64 = wgpu::QUERY_RESOLVE_BUFFER_ALIGNMENT;

fn make_ir(value_shift: usize) -> ChartIR {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = true;
    let proto_series = ir
        .series
        .iter()
        .find(|series| series.id == "line")
        .cloned()
        .unwrap();
    let proto_data = ir.datasets[0].clone();
    ir.series.clear();
    ir.datasets.clear();
    for i in 0..8 {
        let mut data = proto_data.clone();
        data.id = format!("dataset-{i}");
        data.rows = (0..ROWS)
            .map(|row| {
                vec![
                    json!(format!("设备-{row}")),
                    json!(((row as f64) * 0.1).sin() * 3.0 + 4.0 + value_shift as f64),
                    json!(0.5 + value_shift as f64),
                    json!("中文标签"),
                ]
            })
            .collect();
        let dataset_id = data.id.clone();
        ir.datasets.push(data);
        let mut series = proto_series.clone();
        series.id = format!("series-{i}");
        series.label = format!("系列-{i}");
        series.dataset_id = dataset_id;
        ir.series.push(series);
    }
    ir
}

fn rows(variant: usize) -> Vec<Vec<Value>> {
    (0..ROWS)
        .map(|row| {
            vec![
                json!(format!("设备-{row}")),
                json!(((row as f64) * 0.1).sin() * 3.0 + 4.0 + variant as f64),
                json!(0.5 + variant as f64),
                json!("中文标签"),
            ]
        })
        .collect()
}

struct GpuTiming {
    query_set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    frame: usize,
}

impl GpuTiming {
    fn new(device: &wgpu::Device) -> Self {
        let query_set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("chart e2e perf frame timestamps"),
            ty: wgpu::QueryType::Timestamp,
            count: 2,
        });
        let resolve = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("chart e2e perf timestamp ring"),
            size: TS_SLOTS as u64 * SLOT_STRIDE,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        Self {
            query_set,
            resolve,
            frame: 0,
        }
    }

    /// 场景结束读回 [from, to) 帧的 GPU 时长(ms);帧序号即 ring 槽位。
    fn collect(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        period_ns: f64,
        from: usize,
        to: usize,
    ) -> Vec<f64> {
        let size = TS_SLOTS as u64 * SLOT_STRIDE;
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("chart e2e perf timestamp readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &staging, 0, size);
        queue.submit([encoder.finish()]);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        staging.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = sender.send(result);
        });
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("timestamp poll");
        receiver
            .recv()
            .expect("timestamp map callback")
            .expect("timestamp map");
        let mapped = staging.get_mapped_range(..).expect("timestamp view");
        let read = |frame: usize| {
            let base = frame * SLOT_STRIDE as usize;
            let start = u64::from_le_bytes(mapped[base..base + 8].try_into().unwrap());
            let end = u64::from_le_bytes(mapped[base + 8..base + 16].try_into().unwrap());
            end.wrapping_sub(start) as f64 * period_ns / 1e6
        };
        let samples: Vec<f64> = (from..to.min(TS_SLOTS)).map(read).collect();
        drop(mapped);
        staging.unmap();
        samples
    }
}

struct Sample {
    cpu_prepare_ms: f64,
    present_delay_ms: Option<f64>,
    uploaded_bytes: usize,
    staged: bool,
    est_vram_bytes: usize,
}

struct Env {
    _event_loop: winit::event_loop::EventLoop<()>,
    _window: std::sync::Arc<Window>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    ts: Option<GpuTiming>,
    ts_period_ns: f64,
    cache: std::sync::Arc<deep2d_gpu_cache::Deep2dGpuAssetCache>,
    rasterizer: deep_engine_native::platform_text::TextRasterizer,
    anchor: [f64; 2],
    runtime: Option<ChartRuntime>,
    painter: Option<Deep2dGpuPainter>,
    prev_present: Option<Instant>,
    extra_cpu: std::time::Duration,
    last_sample: Option<Sample>,
    adapter: String,
}

impl Env {
    fn new() -> Self {
        let event_loop = winit::event_loop::EventLoop::builder()
            .with_any_thread(true)
            .build()
            .expect("winit event loop on test thread");
        #[allow(deprecated)] // 测试线程无法泵 ActiveEventLoop;EventLoop::create_window 是唯一入口
        let window = std::sync::Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes().with_inner_size(PhysicalSize::new(WIDTH, HEIGHT)),
                )
                .expect("real window"),
        );
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let surface = instance
            .create_surface(window.clone())
            .expect("surface from real window");
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
            ..Default::default()
        }))
        .expect("Vulkan adapter for surface");
        assert_ne!(
            adapter.get_info().device_type,
            wgpu::DeviceType::Cpu,
            "需要真实 GPU"
        );
        let ts_features =
            wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        let ts_supported = adapter.features().contains(ts_features);
        let mut desc = wgpu::DeviceDescriptor::default();
        if ts_supported {
            desc.required_features |= ts_features;
        }
        let (device, queue) = pollster::block_on(adapter.request_device(&desc)).expect("device");
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| {
                matches!(
                    f,
                    wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm
                )
            })
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: WIDTH,
            height: HEIGHT,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Srgb,
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        let ts_period_ns = f64::from(queue.get_timestamp_period());
        let info = adapter.get_info();
        Self {
            _event_loop: event_loop,
            _window: window,
            device: device.clone(),
            queue,
            surface,
            config,
            ts: ts_supported.then(|| GpuTiming::new(&device)),
            ts_period_ns,
            cache: std::sync::Arc::new(deep2d_gpu_cache::Deep2dGpuAssetCache::new()),
            rasterizer: Default::default(),
            anchor: [640.0, 360.0],
            runtime: None,
            painter: None,
            prev_present: None,
            extra_cpu: Default::default(),
            last_sample: None,
            adapter: format!("{} ({:?})", info.name, info.backend),
        }
    }

    /// 场景对 runtime 的数据/交互操作计入 CPU prepare(与帧内 prepare 同口径)。
    fn stage_cpu(&mut self, run: impl FnOnce(&mut ChartRuntime)) {
        let start = Instant::now();
        run(self.runtime.as_mut().expect("runtime staged by scenario"));
        self.extra_cpu += start.elapsed();
    }

    /// 生产入口 present_chart:几何 + tooltip 文字 + 图例,返回本帧 display list。
    fn present(&mut self) -> Deep2dRuntimeContent {
        let runtime = self.runtime.as_ref().expect("runtime");
        Deep2dRuntimeContent::DisplayList(
            present_chart(runtime, &mut self.rasterizer, 0, self.anchor, None)
                .expect("present_chart"),
        )
    }

    fn frame(&mut self, restage: bool) {
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            _ => {
                self.surface.configure(&self.device, &self.config);
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(f)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
                    _ => panic!("surface acquire failed after reconfigure"),
                }
            }
        };
        let now = Instant::now();
        let present_delay_ms = self
            .prev_present
            .replace(now)
            .map(|p| now.duration_since(p).as_secs_f64() * 1000.0);
        let t0 = Instant::now();
        let (w, h) = (self.config.width, self.config.height);
        let (mut uploaded_bytes, mut staged) = (0usize, false);
        if restage {
            let content = self.present();
            let next = match self.painter.take() {
                Some(previous) => previous
                    .stage_update(&self.device, &self.queue, self.config.format, &content)
                    .expect("stage_update"),
                None => Deep2dGpuPainter::new(
                    &self.device,
                    &self.queue,
                    self.config.format,
                    &content,
                    &self.cache,
                )
                .expect("painter new"),
            };
            uploaded_bytes = next.vertex_transfer_stats().uploaded_bytes;
            self.painter = Some(next);
            staged = true;
        }
        let painter = self.painter.as_ref().expect("painter");
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        if let Some(ts) = &self.ts {
            encoder.write_timestamp(&ts.query_set, 0);
        }
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("chart e2e perf clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            ..Default::default()
        }); // pass 结束即 drop
        painter.draw(&mut encoder, &view, (w, h));
        let ts_frame = self.ts.as_ref().map(|ts| {
            encoder.write_timestamp(&ts.query_set, 1);
            encoder.resolve_query_set(
                &ts.query_set,
                0..2,
                &ts.resolve,
                (ts.frame % TS_SLOTS) as u64 * SLOT_STRIDE,
            );
            ts.frame
        });
        if let (Some(ts), Some(index)) = (self.ts.as_mut(), ts_frame) {
            ts.frame = index + 1;
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame); // wgpu 30: 呈现由 queue 收口
        let est_vram_bytes = painter.vertex_transfer_stats().shadow_bytes
            + painter.path_cache_stats().payload_bytes
            + (w * h * 4) as usize;
        self.last_sample = Some(Sample {
            cpu_prepare_ms: (Instant::now() - t0).as_secs_f64() * 1000.0
                + std::mem::take(&mut self.extra_cpu).as_secs_f64() * 1000.0,
            present_delay_ms,
            uploaded_bytes,
            staged,
            est_vram_bytes,
        });
    }
}

fn percentile(sorted: &[f64], p: u32) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((p as f64 / 100.0) * (sorted.len() - 1) as f64).round() as usize]
}

fn scenario_row(
    name: &str,
    samples: Vec<Sample>,
    gpu_ms: Option<Vec<f64>>,
    ts_supported: bool,
) -> Value {
    let mut cpu: Vec<f64> = samples.iter().map(|s| s.cpu_prepare_ms).collect();
    cpu.sort_by(f64::total_cmp);
    let mut present: Vec<f64> = samples.iter().filter_map(|s| s.present_delay_ms).collect();
    present.sort_by(f64::total_cmp);
    let mut gpu = gpu_ms;
    if let Some(g) = &mut gpu {
        g.sort_by(f64::total_cmp);
    }
    let staged: Vec<&Sample> = samples.iter().filter(|s| s.staged).collect();
    let (p, g) = (percentile, gpu.as_deref());
    let uploads: usize = staged.iter().map(|s| s.uploaded_bytes).sum();
    json!({
        "scenario": name, "colors": 8, "samples": samples.len(), "warmup": WARMUP, "unit": "ms",
        "cpu_prepare_p50_ms": p(&cpu, 50), "cpu_prepare_p95_ms": p(&cpu, 95), "cpu_prepare_p99_ms": p(&cpu, 99),
        "present_delay_p50_ms": p(&present, 50), "present_delay_p95_ms": p(&present, 95), "present_delay_p99_ms": p(&present, 99),
        "gpu_frame_p50_ms": g.map(|v| p(v, 50)), "gpu_frame_p95_ms": g.map(|v| p(v, 95)), "gpu_frame_p99_ms": g.map(|v| p(v, 99)),
        "uploaded_bytes_avg_per_stage": uploads.checked_div(staged.len().max(1)).unwrap_or(0), "staged_frames": staged.len(),
        "est_vram_peak_bytes": samples.iter().map(|s| s.est_vram_bytes).max().unwrap_or(0),
        "gpu_timestamps": if ts_supported { "available" } else {
            "degraded: timestamp-query unsupported; gpu_frame 省略, present_delay 为 CPU+present 口径" },
    })
}

fn runtime_for(env: &mut Env, pool: &[ChartIR]) {
    env.runtime = Some(ChartRuntime::new(pool[0].clone(), WIDTH as f64, HEIGHT as f64).unwrap());
}
type Scene = fn(&mut Env, usize, &[ChartIR], &[Vec<Vec<Value>>]);

#[test]
#[cfg(target_os = "windows")]
#[ignore = "explicit Release real-GPU baseline; run with --ignored --nocapture --test-threads=1"]
fn chart_e2e_perf_baseline() {
    let mut env = Env::new();
    let ts_supported = env.ts.is_some();
    let pool: Vec<ChartIR> = (0..4).map(make_ir).collect();
    let local_rows = vec![rows(0), rows(1)];
    println!(
        "{}",
        json!({
            "scenario": "__meta__", "adapter": env.adapter, "backend": "vulkan", "present_mode": "fifo",
            "resolution": format!("{WIDTH}x{HEIGHT}"), "fixture": format!("8 series x {ROWS} rows line chart via present_chart"),
            "declare": "单机单卡固定夹具; 不含跨设备对比与 FPS 结论; est_vram 为估计口径(顶点驻留+细分缓存+后台缓冲, 不含图集纹理与管线); present_delay=上一帧present到本帧acquire完成(含Fifo排队)",
        })
    );
    let scenarios: [(&str, Scene); 7] = [
        ("initial_build", |env, _, pool, _| {
            runtime_for(env, pool);
            env.painter = None;
            env.frame(true);
        }),
        ("static_repeat", |env, _, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            env.frame(env.painter.is_none());
        }),
        ("local_update_one_series", |env, _, pool, local| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            let revision = env.runtime.as_ref().unwrap().data_revision();
            let update = ChartDataUpdate {
                expected_data_revision: revision,
                data_revision: revision + 1,
                datasets: vec![DatasetRowsUpdate::Replace {
                    dataset_id: "dataset-1".into(),
                    rows: local[revision as usize % 2].clone(),
                }],
            };
            env.stage_cpu(|runtime| {
                runtime.update_data(update).unwrap();
            });
            env.frame(true);
        }),
        ("full_replace", |env, _, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            let revision = env.runtime.as_ref().unwrap().data_revision();
            let next = pool[1 + revision as usize % 3].clone();
            env.stage_cpu(|runtime| runtime.replace(next).unwrap());
            env.frame(true);
        }),
        ("resize_1280_960", |env, _, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            let width = if env.config.width == WIDTH {
                960
            } else {
                WIDTH
            };
            let start = Instant::now();
            env.runtime
                .as_mut()
                .unwrap()
                .resize(width as f64, HEIGHT as f64)
                .unwrap();
            env.config.width = width;
            env.surface.configure(&env.device, &env.config);
            env.extra_cpu += start.elapsed();
            env.frame(true);
        }),
        ("legend_toggle", |env, _, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            env.stage_cpu(|runtime| {
                runtime
                    .dispatch(ChartAction::ToggleLegend {
                        series_id: "series-0".into(),
                    })
                    .map(|_| ())
                    .unwrap()
            });
            env.frame(true);
        }),
        ("tooltip_text_update", |env, i, pool, _| {
            if env.runtime.is_none() {
                runtime_for(env, pool);
            }
            let index = i % ROWS;
            env.anchor = [100.0 + (i % 200) as f64, 100.0 + (i % 120) as f64];
            env.stage_cpu(|runtime| {
                runtime
                    .dispatch(ChartAction::Hover {
                        series_id: "series-0".into(),
                        data_index: index,
                        x_label: format!("设备-{index}"),
                        value: format!("{index}.0"),
                    })
                    .map(|_| ())
                    .unwrap()
            });
            env.frame(true);
        }),
    ];
    let mut results = Vec::new();
    for (name, run) in scenarios {
        env.runtime = None;
        env.painter = None;
        env.prev_present = None; // resize 场景把 surface 留在 960;每场景归位 1280 保证后台缓冲口径一致
        env.config.width = WIDTH;
        env.surface.configure(&env.device, &env.config);
        let mut samples = Vec::new();
        let ts_from = env.ts.as_ref().map_or(0, |ts| ts.frame);
        for i in 0..WARMUP + SAMPLES {
            run(&mut env, i, &pool, &local_rows);
            if i >= WARMUP {
                samples.push(env.last_sample.take().expect("每帧产生一个采样"));
            }
        }
        let period = env.ts_period_ns;
        let gpu_ms = env
            .ts
            .as_ref()
            .map(|ts| ts.collect(&env.device, &env.queue, period, ts_from, ts.frame));
        let row = scenario_row(name, samples, gpu_ms, ts_supported);
        println!("{row}");
        results.push(row);
    }
    println!("--- 汇总(机器可读,一行一个 JSON) ---");
    for row in &results {
        println!("{row}");
    }
}
