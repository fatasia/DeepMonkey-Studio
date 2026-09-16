use crate::{
    gpu_culling::GpuCulling, gpu_lod::GpuLod, gpu_scene::GpuScene, gpu_scene_draw::DrawFrame,
    pipeline::MeshPipelines, shadow_map::ShadowMap,
};

pub fn encode_shadow_cascades(
    encoder: &mut wgpu::CommandEncoder,
    shadow_map: &ShadowMap,
    scene: &GpuScene,
    culling: &GpuCulling,
    lod: Option<&GpuLod>,
    pipelines: &MeshPipelines,
    dirty_mask: u8,
) {
    for (cascade_index, layer_view) in shadow_map.layer_views.iter().enumerate() {
        if dirty_mask & (1 << cascade_index) == 0 {
            continue;
        }
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native cached cascade shadow pass"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: layer_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_bind_group(
            0,
            &shadow_map.shadow_frame_bind_group,
            &[shadow_map.dynamic_offset(cascade_index)],
        );
        let culling_view = cascade_index + 1;
        scene.draw_shadow_indirect(
            &mut pass,
            pipelines,
            culling,
            lod,
            DrawFrame {
                builtin: &shadow_map.shadow_frame_bind_group,
                cascade: Some((cascade_index, shadow_map.dynamic_offset(cascade_index))),
            },
            culling_view,
        );
    }
}
