//! F2 RT pixel 定向 GPU 测试(windows):真机 ray-query 设备上创建 RT
//! opaque/MASK 管线族,验证 `fragment_main_rt` 拼接模块的 WGSL 合法性与
//! binding 10 布局对齐。非 RT 适配器上跳过(与 hardware_ray_query 同界)。

// F2 RT/栅格同场景阴影像素对拍作为本模块的子模块挂载,避免改动
// renderer.rs 的模块清单(该文件在共享工作树中有并行会话的进行中改动)。
#[cfg(test)]
#[path = "rt_raster_parity_gpu_tests.rs"]
mod rt_raster_parity_gpu_tests;

use crate::frame_bindings::{create_frame_layouts, create_native_mesh_rt_shader};
use crate::gpu_textures::create_material_layout;
use crate::pipeline::create_rt_mesh_pipelines;

/// 真机 ray-query 设备请求;RT/栅格像素对拍(rt_raster_parity_gpu_tests)
/// 与本文件同界复用。非 RT 适配器返回 None,调用方按测试跳过处理。
pub(crate) fn request_ray_query_device() -> Option<(wgpu::Device, wgpu::Queue)> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).ok()?;
    if !adapter
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
    {
        return None;
    }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        required_limits: {
            let available = adapter.limits();
            let mut limits = wgpu::Limits::default();
            limits.max_blas_primitive_count = available.max_blas_primitive_count;
            limits.max_blas_geometry_count = available.max_blas_geometry_count;
            limits.max_tlas_instance_count = available.max_tlas_instance_count;
            limits.max_acceleration_structures_per_shader_stage =
                available.max_acceleration_structures_per_shader_stage;
            limits.max_buffers_and_acceleration_structures_per_shader_stage =
                available.max_buffers_and_acceleration_structures_per_shader_stage;
            limits
        },
        ..Default::default()
    }))
    .expect("RT-capable adapter must create a ray-query device");
    Some((device, queue))
}

#[test]
fn rt_fragment_pipeline_family_compiles_on_ray_query_device() {
    let Some((device, _queue)) = request_ray_query_device() else {
        return;
    };
    let layouts = create_frame_layouts(&device);
    let frame_rt = layouts
        .frame_rt
        .expect("ray-query device must expose the RT frame layout");
    let material_layout = create_material_layout(&device);
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let shader = create_native_mesh_rt_shader(&device);
    // 六变体(standard/normal_mapped × regular/mirrored/double_sided)全部
    // 创建成功且 error scope 干净,即 fragment_main_rt 与 binding 10 布局
    // 对齐;任何 WGSL/布局失配都会在此暴露。
    let _pipelines = create_rt_mesh_pipelines(&device, &frame_rt, &material_layout, &shader);
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    let error = pollster::block_on(validation.pop());
    assert!(
        error.is_none(),
        "RT fragment pipeline family must validate cleanly: {error:?}"
    );
}
