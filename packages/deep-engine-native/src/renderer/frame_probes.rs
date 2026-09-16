use crate::mesh_pass::encode_mesh_passes;

use super::Renderer;

pub(super) fn encode_differential_probes(renderer: &Renderer, encoder: &mut wgpu::CommandEncoder) {
    if let Some(probe) = &renderer.shadow_probe {
        probe.clear_unshadowed_map(encoder);
        encode_mesh_passes(
            encoder,
            &renderer.forward_targets,
            probe.disabled_frame_bind_group(),
            &renderer.scene,
            &renderer.culling,
            renderer.lod.as_ref(),
            &renderer.pipelines,
            renderer.yaw,
        );
        probe.copy_unshadowed(encoder, renderer.forward_targets.resolved_texture());
    }
    if let Some(probe) = &renderer.ibl_probe {
        encode_mesh_passes(
            encoder,
            &renderer.forward_targets,
            probe.disabled_frame_bind_group(),
            &renderer.scene,
            &renderer.culling,
            renderer.lod.as_ref(),
            &renderer.pipelines,
            renderer.yaw,
        );
        probe.copy_disabled(encoder, renderer.forward_targets.resolved_texture());
    }
}
