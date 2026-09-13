use crate::{
    forward_targets::ForwardTargets, gpu_culling::GpuCulling, gpu_lod::GpuLod, gpu_scene::GpuScene,
    gpu_scene_draw::DrawFrame, pipeline::MeshPipelines,
};

#[allow(clippy::too_many_arguments)]
pub fn encode_mesh_passes(
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    frame_bind_group: &wgpu::BindGroup,
    scene: &GpuScene,
    culling: &GpuCulling,
    lod: Option<&GpuLod>,
    pipelines: &MeshPipelines,
    yaw: f32,
) {
    let has_transparent = scene.has_transparent();
    {
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &targets.msaa_view,
            depth_slice: None,
            resolve_target: Some(&targets.hdr_view),
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color {
                    r: 0.012,
                    g: 0.020,
                    b: 0.035,
                    a: 1.0,
                }),
                store: if has_transparent {
                    wgpu::StoreOp::Store
                } else {
                    wgpu::StoreOp::Discard
                },
            },
        })];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native opaque and mask pass"),
            color_attachments: &color_attachments,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &targets.depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: if has_transparent {
                        wgpu::StoreOp::Store
                    } else {
                        wgpu::StoreOp::Discard
                    },
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_bind_group(0, frame_bind_group, &[]);
        scene.draw_solid_indirect(
            &mut pass,
            pipelines,
            culling,
            lod,
            DrawFrame {
                builtin: frame_bind_group,
                cascade: None,
            },
        );
    }
    if has_transparent {
        encode_blend_pass(
            encoder,
            targets,
            frame_bind_group,
            scene,
            culling,
            lod,
            pipelines,
            yaw,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn encode_blend_pass(
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    frame_bind_group: &wgpu::BindGroup,
    scene: &GpuScene,
    culling: &GpuCulling,
    lod: Option<&GpuLod>,
    pipelines: &MeshPipelines,
    yaw: f32,
) {
    let color_attachments = [Some(wgpu::RenderPassColorAttachment {
        view: &targets.msaa_view,
        depth_slice: None,
        resolve_target: Some(&targets.hdr_view),
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Load,
            store: wgpu::StoreOp::Discard,
        },
    })];
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Deep Engine native globally sorted alpha blend pass"),
        color_attachments: &color_attachments,
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: &targets.depth_view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Discard,
            }),
            stencil_ops: None,
        }),
        ..Default::default()
    });
    pass.set_bind_group(0, frame_bind_group, &[]);
    pass.set_vertex_buffer(1, scene.instance_buffer.slice(..));
    scene.draw_transparent(
        &mut pass,
        pipelines,
        culling,
        lod,
        DrawFrame {
            builtin: frame_bind_group,
            cascade: None,
        },
        yaw,
    );
}
