//! Material reconstruction and winner visibility stay GPU resident between RIS passes.
use super::megalights_gbuffer::MegaLightsGBuffer;
use super::megalights_gpu::{combined_clip_to_view, invert4, world_to_view};
use deep_engine_native::player_view::PlayerView;

struct Pass {
    pipeline: wgpu::ComputePipeline,
    bind: wgpu::BindGroup,
    params: wgpu::Buffer,
}
pub(super) struct MegaLightsInputs {
    surface: Pass,
    visibility: Pass,
    pub tlas: wgpu::Tlas,
    full: (u32, u32),
    pub composite: super::megalights_composite::Composite,
}

impl MegaLightsInputs {
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        device: &wgpu::Device,
        gbuffer: &MegaLightsGBuffer,
        depth: &wgpu::TextureView,
        surfaces: &wgpu::Buffer,
        reservoirs: &wgpu::Buffer,
        lights: &wgpu::Buffer,
        mask: &wgpu::Buffer,
        color: &wgpu::Buffer,
        tlas: &wgpu::Tlas,
    ) -> Self {
        let make = |source: &str, label, size| {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: None,
                module: &shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
            let params = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            (pipeline, params)
        };
        let (pipeline, params) = make(
            include_str!("../../assets/shaders/native_megalights_surface.wgsl"),
            "MegaLights actual surface",
            160,
        );
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("MegaLights surface bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                buffer(0, &params),
                texture(1, depth),
                buffer(2, surfaces),
                texture(3, &gbuffer.base_metal),
                texture(4, &gbuffer.normal_rough),
            ],
        });
        let surface = Pass {
            pipeline,
            params,
            bind,
        };
        let (pipeline, params) = make(
            include_str!("../../assets/shaders/native_megalights_visibility.wgsl"),
            "MegaLights winner TLAS visibility",
            80,
        );
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("MegaLights visibility bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                buffer(0, &params),
                buffer(1, surfaces),
                buffer(2, reservoirs),
                buffer(3, lights),
                buffer(4, mask),
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: tlas.as_binding(),
                },
            ],
        });
        let visibility = Pass {
            pipeline,
            params,
            bind,
        };
        Self {
            surface,
            visibility,
            tlas: tlas.clone(),
            full: gbuffer.dimensions,
            composite: super::megalights_composite::Composite::create(
                device, gbuffer, depth, color, surfaces,
            ),
        }
    }

    // Explicit GPU binding and uniform ABI inputs.
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        queue: &wgpu::Queue,
        view: PlayerView,
        projection: &[[f32; 4]; 4],
        width: u32,
        height: u32,
        count: u32,
        shadow_mask: u32,
    ) {
        let world_to_view = world_to_view(view);
        let clip = combined_clip_to_view(view, projection).expect("validated MegaLights camera");
        let inverse = invert4(&world_to_view).expect("rigid camera inverse");
        let mut words = [0u32; 40];
        for (index, value) in clip
            .iter()
            .flatten()
            .chain(world_to_view.iter().flatten())
            .enumerate()
        {
            words[index] = value.to_bits();
        }
        words[32] = width;
        words[33] = height;
        words[34] = self.full.0;
        words[35] = self.full.1;
        queue.write_buffer(&self.surface.params, 0, bytemuck::cast_slice(&words));
        let mut words = [0u32; 20];
        for (index, value) in inverse.iter().flatten().enumerate() {
            words[index] = value.to_bits();
        }
        words[16] = width;
        words[17] = height;
        words[18] = count;
        words[19] = shadow_mask;
        queue.write_buffer(&self.visibility.params, 0, bytemuck::cast_slice(&words));
    }

    pub fn rebuild(&self, encoder: &mut wgpu::CommandEncoder, width: u32, height: u32) {
        encode(&self.surface, encoder, width, height);
    }
    pub fn visibility(&self, encoder: &mut wgpu::CommandEncoder, width: u32, height: u32) {
        encode(&self.visibility, encoder, width, height);
    }
}
fn buffer(binding: u32, resource: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: resource.as_entire_binding(),
    }
}
fn texture(binding: u32, view: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::TextureView(view),
    }
}
fn encode(pass: &Pass, encoder: &mut wgpu::CommandEncoder, width: u32, height: u32) {
    let mut compute = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("MegaLights actual input"),
        ..Default::default()
    });
    compute.set_pipeline(&pass.pipeline);
    compute.set_bind_group(0, &pass.bind, &[]);
    compute.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
}
