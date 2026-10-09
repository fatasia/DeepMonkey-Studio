use crate::renderer::{
    initial_preparation::InitialPreparationClock, rt_residency::RtSceneResidency,
};
#[allow(clippy::too_many_arguments)]
pub(super) async fn prepare(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    scene: &crate::gpu_scene::GpuScene,
    initial_preparation_clock: &mut Option<InitialPreparationClock>,
    diagnostics: &mut crate::player_diagnostics::PlayerDiagnostics,
    rt_frame_layout: Option<&wgpu::BindGroupLayout>,
    material_layout: &wgpu::BindGroupLayout,
    layered_material_layout: Option<&wgpu::BindGroupLayout>,
    has_layered_materials: bool,
    ibl: &crate::gpu_ibl::GpuIblEnvironment,
    frame_buffer: &wgpu::Buffer,
    ies_buffer: &wgpu::Buffer,
    shadow_map: &crate::shadow_map::ShadowMap,
    probe_frame_buffer: &wgpu::Buffer,
) -> (Option<RtSceneResidency>, Option<wgpu::BindGroup>) {
    // F2:硬件 RT 驻留(静态实例 BLAS 缓存 + 场景 TLAS)在栅格原子事务之外
    // 建立——任何拒绝都 fail-closed 关闭 RT 并记录诊断原因,绝不阻塞栅格主通路。
    let mut rt_residency =
        match crate::renderer::rt_residency::RtSceneResidency::build(device, scene) {
            Ok((residency, blas_encoder, tlas_encoder)) => {
                // BLAS 必须先于 TLAS 完成;单次 submit 内 FIFO 保证 GPU 执行序。
                match initial_preparation_clock.as_mut() {
                    Some(clock) => clock.upload_timed(|| {
                        queue.submit([blas_encoder.finish(), tlas_encoder.finish()])
                    }),
                    None => queue.submit([blas_encoder.finish(), tlas_encoder.finish()]),
                };
                diagnostics.note_rt_tlas_resident();
                Some(residency)
            }
            // 能力缺失维持既有 adapter/device 精确原因,不覆盖。
            Err(crate::renderer::rt_residency::RtResidencyReject::MissingFeature) => None,
            Err(reject) => {
                diagnostics.note_rt_tlas_rejected(reject.reason());
                None
            }
        };
    let rt_frame_bind_group = match (&rt_residency, rt_frame_layout) {
        (Some(residency), Some(layout)) => Some(ibl.create_rt_frame_bind_group(
            device,
            layout,
            frame_buffer,
            Some(ies_buffer),
            shadow_map,
            residency.tlas(),
            Some(probe_frame_buffer),
            "Deep Engine native RT frame bindings",
        )),
        _ => None,
    };
    // F2 pixel:opaque/MASK 方向阴影 Ray Query 管线族。与驻留同在栅格原子
    // 事务之外:创建走独立 validation error scope,失败仅丢弃管线族并记录
    // 精确原因(fail-closed 回退栅格),不阻塞渲染器创建。含 custom shader
    // 批次的场景不创建——其批次只能绑定普通 frame layout,RT frame bind
    // group 无法与之混用,整帧回退栅格由帧循环判定。
    let rt_pixel_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    if let (Some(residency), Some(layout)) = (rt_residency.as_mut(), rt_frame_layout)
        && scene.shader_materials.is_none()
    {
        let rt_shader = crate::frame_bindings::create_native_mesh_rt_shader(device);
        let rt_pipelines = match (has_layered_materials, layered_material_layout) {
            (true, Some(layered_layout)) => crate::pipeline::create_rt_mesh_pipelines_with_layered(
                device,
                layout,
                material_layout,
                layered_layout,
                &rt_shader,
            ),
            _ => crate::pipeline::create_rt_mesh_pipelines(
                device,
                layout,
                material_layout,
                &rt_shader,
            ),
        };
        residency.install_pixel_pipelines(rt_pipelines);
    }
    match rt_pixel_scope.pop().await {
        Some(_) => {
            if let Some(residency) = rt_residency.as_mut() {
                residency.drop_pixel_pipelines();
            }
            diagnostics.note_rt_pixel_rejected();
        }
        None if rt_residency
            .as_ref()
            .is_some_and(|residency| residency.pixel_pipelines().is_some()) =>
        {
            // 驻留 + RT frame 绑定 + Ray Query 管线族全部就绪:诊断从
            // tlas_resident_pixel_pending 升级为真实像素消费态。
            diagnostics.note_rt_directional_shadow_pixels();
        }
        None => {}
    }
    (rt_residency, rt_frame_bind_group)
}
