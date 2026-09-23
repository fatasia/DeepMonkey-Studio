use std::sync::Arc;

use winit::{dpi::PhysicalSize, event_loop::EventLoopProxy, window::Window};

use crate::{events::GpuEvent, gpu_submission::GpuFailures};

pub(crate) struct GpuContext {
    pub(crate) instance: wgpu::Instance,
    pub(crate) window: Arc<Window>,
    pub(crate) surface: wgpu::Surface<'static>,
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
    pub(crate) adapter_info: wgpu::AdapterInfo,
    pub(crate) adapter_features: wgpu::Features,
    pub(crate) device_features: wgpu::Features,
    pub(crate) config: wgpu::SurfaceConfiguration,
    pub(crate) size: PhysicalSize<u32>,
    pub(crate) failures: GpuFailures,
}

pub(crate) async fn create_gpu_context(
    window: Arc<Window>,
    proxy: EventLoopProxy<GpuEvent>,
    renderer_id: u64,
    request_timestamps: bool,
) -> Result<GpuContext, String> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    // wasm:浏览器 WebGPU(必要时 GL 兜底);桌面:DX12/Metal/Vulkan 各取所长。
    #[cfg(target_arch = "wasm32")]
    {
        descriptor.backends = wgpu::Backends::BROWSER_WEBGPU | wgpu::Backends::GL;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::METAL | wgpu::Backends::VULKAN;
    }
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
    let adapter_info = adapter.get_info();
    let adapter_features = adapter.features();
    // Timestamps are only requested when telemetry needs them and the adapter
    // actually supports them, so the default path keeps an unmodified feature set.
    // wgpu 30 exposes the experimental acceleration-structure API on DX12 and
    // Vulkan. Request it only when the selected adapter advertises the exact
    // feature; unsupported GPUs retain the software BVH/TLAS path.
    let mut required_features = if request_timestamps {
        adapter_features
            & (wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)
    } else {
        wgpu::Features::empty()
    };
    if adapter_features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
        required_features |= wgpu::Features::EXPERIMENTAL_RAY_QUERY;
    }
    let available_limits = adapter.limits();
    let mut required_limits = wgpu::Limits::default();
    // 下限设备(模拟器 SwiftShader、部分手机驱动)的 UBO 绑定上限可能只有
    // 16KiB:请求值收敛到适配器实际能力,避免设备创建被整体拒绝;
    // 桌面主路适配器通常 ≥64KiB,不受影响。
    required_limits.max_uniform_buffer_binding_size = required_limits
        .max_uniform_buffer_binding_size
        .min(available_limits.max_uniform_buffer_binding_size);
    if required_features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
        required_limits.max_blas_primitive_count = available_limits.max_blas_primitive_count;
        required_limits.max_blas_geometry_count = available_limits.max_blas_geometry_count;
        required_limits.max_tlas_instance_count = available_limits.max_tlas_instance_count;
        required_limits.max_acceleration_structures_per_shader_stage =
            available_limits.max_acceleration_structures_per_shader_stage;
        required_limits.max_buffers_and_acceleration_structures_per_shader_stage =
            available_limits.max_buffers_and_acceleration_structures_per_shader_stage;
    }
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("Deep Engine native device"),
            required_features,
            required_limits,
            // wgpu gates its experimental acceleration-structure API behind an
            // explicit opt-in token. Only acknowledge it when this selected
            // adapter actually advertises Ray Query.
            experimental_features: if required_features
                .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
            {
                unsafe { wgpu::ExperimentalFeatures::enabled() }
            } else {
                wgpu::ExperimentalFeatures::disabled()
            },
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
    println!(
        "native GPU: {} ({:?}, {:?}) surface={:?}",
        adapter_info.name, adapter_info.backend, adapter_info.device_type, config.format
    );
    Ok(GpuContext {
        instance,
        window,
        surface,
        device,
        queue,
        adapter_info,
        adapter_features,
        device_features: required_features,
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
