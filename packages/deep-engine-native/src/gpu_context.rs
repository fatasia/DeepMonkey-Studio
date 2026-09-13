use std::sync::Arc;

use winit::{dpi::PhysicalSize, event_loop::EventLoopProxy, window::Window};

use crate::{events::GpuEvent, gpu_submission::GpuFailures};

pub(crate) struct GpuContext {
    pub(crate) surface: wgpu::Surface<'static>,
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
    pub(crate) config: wgpu::SurfaceConfiguration,
    pub(crate) size: PhysicalSize<u32>,
    pub(crate) failures: GpuFailures,
}

pub(crate) async fn create_gpu_context(
    window: Arc<Window>,
    proxy: EventLoopProxy<GpuEvent>,
    renderer_id: u64,
) -> Result<GpuContext, String> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::METAL | wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let surface = instance
        .create_surface(window.clone())
        .map_err(|error| format!("surface creation failed: {error}"))?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .map_err(|error| format!("GPU adapter request failed: {error}"))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("Deep Engine native device"),
            ..Default::default()
        })
        .await
        .map_err(|error| format!("GPU device request failed: {error}"))?;

    let failures = GpuFailures::default();
    register_device_callbacks(&device, proxy, renderer_id, failures.clone());
    let size = window.inner_size();
    let mut config = surface
        .get_default_config(&adapter, size.width.max(1), size.height.max(1))
        .ok_or("adapter cannot present to the native window surface")?;
    config.present_mode = wgpu::PresentMode::AutoVsync;
    config.desired_maximum_frame_latency = 2;
    let info = adapter.get_info();
    println!(
        "native GPU: {} ({:?}, {:?}) surface={:?}",
        info.name, info.backend, info.device_type, config.format
    );
    Ok(GpuContext {
        surface,
        device,
        queue,
        config,
        size,
        failures,
    })
}

fn register_device_callbacks(
    device: &wgpu::Device,
    proxy: EventLoopProxy<GpuEvent>,
    renderer_id: u64,
    failures: GpuFailures,
) {
    let lost_proxy = proxy.clone();
    let lost_failures = failures.clone();
    device.set_device_lost_callback(move |reason, message| {
        lost_failures.record(format!("device lost ({reason:?}): {message}"));
        let _ = lost_proxy.send_event(GpuEvent::DeviceLost {
            renderer_id,
            reason: format!("{reason:?}"),
            message,
        });
    });
    device.on_uncaptured_error(Arc::new(move |error| {
        failures.record(error.to_string());
        let _ = proxy.send_event(GpuEvent::UncapturedError {
            renderer_id,
            message: error.to_string(),
        });
    }));
}
