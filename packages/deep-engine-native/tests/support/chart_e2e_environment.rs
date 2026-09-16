use super::deep2d_gpu::Deep2dGpuPainter;
use super::measurements::{GpuTiming, Sample};
use super::{HEIGHT, SLOT_STRIDE, TS_SLOTS, WIDTH, deep2d_gpu_cache};
use deep_engine_native::chart::{ChartRuntime, presentation::present_chart};
use deep_engine_native::deep2d::Deep2dRuntimeContent;
use std::time::Instant;
use winit::{dpi::PhysicalSize, platform::windows::EventLoopBuilderExtWindows, window::Window};

pub(super) struct Env {
    pub(super) _event_loop: winit::event_loop::EventLoop<()>,
    pub(super) _window: std::sync::Arc<Window>,
    pub(super) device: wgpu::Device,
    pub(super) queue: wgpu::Queue,
    pub(super) surface: wgpu::Surface<'static>,
    pub(super) config: wgpu::SurfaceConfiguration,
    pub(super) ts: Option<GpuTiming>,
    pub(super) ts_period_ns: f64,
    pub(super) cache: std::sync::Arc<deep2d_gpu_cache::Deep2dGpuAssetCache>,
    pub(super) rasterizer: deep_engine_native::platform_text::TextRasterizer,
    pub(super) anchor: [f64; 2],
    pub(super) runtime: Option<ChartRuntime>,
    pub(super) painter: Option<Deep2dGpuPainter>,
    pub(super) prev_present: Option<Instant>,
    pub(super) extra_cpu: std::time::Duration,
    pub(super) last_sample: Option<Sample>,
    pub(super) adapter: String,
}

impl Env {
    pub(super) fn new() -> Self {
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
    pub(super) fn stage_cpu(&mut self, run: impl FnOnce(&mut ChartRuntime)) {
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

    pub(super) fn frame(&mut self, restage: bool) {
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
