use deep_engine_native::{
    contract::AlphaMode,
    culling_contract::{GPU_CULLING_INDIRECT_BYTES, GPU_CULLING_INSTANCE_BYTES},
    scene::{DrawBatch, transparent_batch_order},
    shadow_cache::shadow_caster_mode,
};

use crate::{
    gpu_culling::GpuCulling, gpu_lod::GpuLod, gpu_scene::GpuScene, pipeline::MeshPipelines,
    player_shader_plan::raster_slot,
};

#[derive(Clone, Copy)]
pub struct DrawFrame<'a> {
    pub builtin: &'a wgpu::BindGroup,
    pub cascade: Option<(usize, u32)>,
}

impl<'a> DrawFrame<'a> {
    fn bind_builtin(self, pass: &mut wgpu::RenderPass<'a>) {
        if let Some((_, offset)) = self.cascade {
            pass.set_bind_group(0, self.builtin, &[offset]);
        } else {
            pass.set_bind_group(0, self.builtin, &[]);
        }
    }
}

impl GpuScene {
    pub fn draw_solid_indirect<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        pipelines: &'a MeshPipelines,
        culling: &'a GpuCulling,
        lod: Option<&'a GpuLod>,
        frame: DrawFrame<'a>,
    ) {
        for (index, batch) in self.batches.iter().enumerate() {
            if batch.alpha_mode != AlphaMode::Blend {
                self.draw_selected(pass, pipelines, culling, lod, frame, index, 0);
            }
        }
    }

    pub fn draw_transparent<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        pipelines: &'a MeshPipelines,
        culling: &'a GpuCulling,
        lod: Option<&'a GpuLod>,
        frame: DrawFrame<'a>,
        yaw: f32,
    ) {
        // Each BLEND object remains a separate batch. GPU selection changes only
        // its geometry, so neither atomic compaction nor LOD level order can reorder it.
        for index in transparent_batch_order(&self.batches, yaw) {
            let batch = &self.batches[index];
            if batch.lod {
                self.draw_selected(pass, pipelines, culling, lod, frame, index, 0);
            } else {
                self.bind_color(pass, pipelines, batch, frame);
                pass.set_vertex_buffer(1, self.instance_buffer.slice(..));
                pass.draw_indexed(
                    0..self.geometries[batch.geometry_index].index_count,
                    0,
                    batch.instance_start..batch.instance_start + batch.instance_count,
                );
            }
        }
    }

    pub fn draw_shadow_indirect<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        pipelines: &'a MeshPipelines,
        culling: &'a GpuCulling,
        lod: Option<&'a GpuLod>,
        frame: DrawFrame<'a>,
        view: usize,
    ) {
        for (index, batch) in self.batches.iter().enumerate() {
            if batch.alpha_mode != AlphaMode::Blend {
                self.draw_selected(pass, pipelines, culling, lod, frame, index, view);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_selected<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        pipelines: &'a MeshPipelines,
        culling: &'a GpuCulling,
        lod: Option<&'a GpuLod>,
        frame: DrawFrame<'a>,
        index: usize,
        view: usize,
    ) {
        let batch = &self.batches[index];
        if batch.lod {
            let lod = lod.expect("validated LOD batches retain GPU resources");
            for draw in lod.draws(index).iter().filter(|draw| draw.resident) {
                let mut selected = batch.clone();
                selected.geometry_index = draw.geometry_index;
                selected.instance_start = draw.instance_start;
                self.draw_indirect(
                    pass,
                    pipelines,
                    &selected,
                    lod.visible(view),
                    lod.indirect(view),
                    draw.indirect_index as usize,
                    frame,
                );
            }
        } else {
            self.draw_indirect(
                pass,
                pipelines,
                batch,
                culling.visible_instances(view),
                culling.indirect(view),
                index,
                frame,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_indirect<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        pipelines: &'a MeshPipelines,
        batch: &DrawBatch,
        visible: &'a wgpu::Buffer,
        indirect: &'a wgpu::Buffer,
        index: usize,
        frame: DrawFrame<'a>,
    ) {
        if let Some((cascade, _)) = frame.cascade {
            let material = &self.pbr.materials[batch.material_index];
            let Some(mode) = shadow_caster_mode(batch.alpha_mode, material.base_color_mapped)
            else {
                return;
            };
            if let Some(custom) = self
                .shader_materials
                .as_ref()
                .and_then(|set| set.materials[batch.material_index].as_ref())
            {
                let custom = custom.shadow[raster_slot(batch)]
                    .as_ref()
                    .expect("validated custom shadow pass");
                pass.set_pipeline(&custom.pipeline);
                pass.set_bind_group(0, &custom.frames[cascade], &[]);
                if let Some(material) = &custom.material {
                    pass.set_bind_group(1, material, &[]);
                }
            } else {
                let (pipeline, uses_material) =
                    pipelines.select_shadow(mode, batch.mirrored, batch.double_sided);
                pass.set_pipeline(pipeline);
                if self.shader_materials.is_some() {
                    frame.bind_builtin(pass);
                }
                if uses_material {
                    pass.set_bind_group(1, &material.bind_group, &[]);
                }
            }
            let geometry = &self.geometries[batch.geometry_index];
            pass.set_vertex_buffer(0, geometry.vertex_buffer.slice(..));
            pass.set_index_buffer(geometry.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        } else {
            self.bind_color(pass, pipelines, batch, frame);
        }
        pass.set_vertex_buffer(
            1,
            visible.slice(u64::from(batch.instance_start) * GPU_CULLING_INSTANCE_BYTES..),
        );
        pass.draw_indexed_indirect(indirect, index as u64 * GPU_CULLING_INDIRECT_BYTES);
    }

    fn bind_color<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        pipelines: &'a MeshPipelines,
        batch: &DrawBatch,
        frame: DrawFrame<'a>,
    ) {
        let geometry = &self.geometries[batch.geometry_index];
        let material = &self.pbr.materials[batch.material_index];
        let tangent = if let Some(custom) = self
            .shader_materials
            .as_ref()
            .and_then(|set| set.materials[batch.material_index].as_ref())
        {
            let custom = custom.forward[raster_slot(batch)]
                .as_ref()
                .expect("validated custom forward pass");
            pass.set_pipeline(&custom.pipeline);
            pass.set_bind_group(0, &custom.frames[0], &[]);
            if let Some(material) = &custom.material {
                pass.set_bind_group(1, material, &[]);
            }
            custom.tangent
        } else {
            pass.set_pipeline(pipelines.select(
                batch.alpha_mode,
                batch.mirrored,
                batch.double_sided,
                material.normal_mapped,
            ));
            if self.shader_materials.is_some() {
                frame.bind_builtin(pass);
            }
            pass.set_bind_group(1, &material.bind_group, &[]);
            material.normal_mapped
        };
        pass.set_vertex_buffer(0, geometry.vertex_buffer.slice(..));
        if tangent {
            pass.set_vertex_buffer(
                2,
                geometry
                    .tangent_buffer
                    .as_ref()
                    .expect("validated normal-mapped geometry retains tangents")
                    .slice(..),
            );
        }
        pass.set_index_buffer(geometry.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
    }
}
