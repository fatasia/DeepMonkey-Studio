use crate::{
    forward_targets::ForwardTargets, gpu_culling::GpuCulling, gpu_lod::GpuLod, gpu_scene::GpuScene,
    gpu_scene_draw::DrawFrame, pipeline::MeshPipelines, pipeline::RtMeshPipelines,
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
    encode_opaque_pass(
        encoder,
        targets,
        frame_bind_group,
        scene,
        culling,
        lod,
        pipelines,
        false,
    );
    encode_transparent_pass(
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

#[allow(clippy::too_many_arguments)]
pub fn encode_opaque_pass(
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    frame_bind_group: &wgpu::BindGroup,
    scene: &GpuScene,
    culling: &GpuCulling,
    lod: Option<&GpuLod>,
    pipelines: &MeshPipelines,
    // HiZ 生产接线:opaque 深度是金字塔的源,pass 后要按纹理读,必须 Store。
    retain_depth: bool,
) {
    let has_transparent = scene.has_transparent();
    {
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &targets.msaa_view,
            depth_slice: None,
            resolve_target: Some(&targets.hdr_view),
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(targets.clear_color()),
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
                    store: if has_transparent || retain_depth {
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
}

#[allow(clippy::too_many_arguments)]
pub fn encode_transparent_pass(
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    frame_bind_group: &wgpu::BindGroup,
    scene: &GpuScene,
    culling: &GpuCulling,
    lod: Option<&GpuLod>,
    pipelines: &MeshPipelines,
    yaw: f32,
) {
    if !scene.has_transparent() {
        return;
    }
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
                store: if targets.outline.is_some() {
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

pub fn encode_outline_mask(
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    frame_bind_group: &wgpu::BindGroup,
    scene: &GpuScene,
    pipelines: &[wgpu::RenderPipeline; 3],
    culling: &GpuCulling,
    lod: Option<&GpuLod>,
) {
    let Some(outline) = &targets.outline else {
        return;
    };
    let attachments = [Some(wgpu::RenderPassColorAttachment {
        view: &outline.mask_view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            store: wgpu::StoreOp::Store,
        },
    })];
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Deep Engine native selected-object mask pass"),
        color_attachments: &attachments,
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: &outline.depth_view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(1.0),
                store: wgpu::StoreOp::Store,
            }),
            stencil_ops: None,
        }),
        ..Default::default()
    });
    pass.set_bind_group(0, frame_bind_group, &[]);
    scene.draw_outline(&mut pass, pipelines, culling, lod);
}

/// F2 RT pixel:opaque/MASK pass 的 Ray Query 变体。pass 结构、清屏、
/// 深度语义(transparent 存续或 HiZ/outline 生产时 Store)与
/// `encode_opaque_pass` 完全一致;差异仅在 group 0 绑 RT frame(含
/// binding 10 TLAS)与管线族走 `fragment_main_rt`。调用方保证 RT 就绪
/// (设备启用 ray query、TLAS 驻留成功、管线族已创建、场景无 custom
/// shader 批次);任一条件不满足时帧循环回退 `encode_opaque_pass`。
#[allow(clippy::too_many_arguments)]
pub fn encode_opaque_pass_rt(
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    rt_frame_bind_group: &wgpu::BindGroup,
    scene: &GpuScene,
    culling: &GpuCulling,
    lod: Option<&GpuLod>,
    pipelines: &RtMeshPipelines,
    retain_depth: bool,
) {
    let has_transparent = scene.has_transparent();
    {
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &targets.msaa_view,
            depth_slice: None,
            resolve_target: Some(&targets.hdr_view),
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(targets.clear_color()),
                store: if has_transparent {
                    wgpu::StoreOp::Store
                } else {
                    wgpu::StoreOp::Discard
                },
            },
        })];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native RT opaque and mask pass"),
            color_attachments: &color_attachments,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &targets.depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: if has_transparent || retain_depth {
                        wgpu::StoreOp::Store
                    } else {
                        wgpu::StoreOp::Discard
                    },
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_bind_group(0, rt_frame_bind_group, &[]);
        scene.draw_solid_rt(&mut pass, pipelines, culling, lod);
    }
}
