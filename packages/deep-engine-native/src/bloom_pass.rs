use bytemuck::{Pod, Zeroable};
use deep_engine_native::{bloom::BloomSettings, mesh_abi::FORWARD_COLOR_FORMAT};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

use crate::bloom_pipeline::{create_layout, create_pipeline};

const SHADER: &str = include_str!("../assets/shaders/native_bloom_v1.wgsl");

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct BloomUniform {
    threshold: f32,
    soft_knee: f32,
    radius: f32,
    _padding: f32,
}

pub struct BloomPass {
    settings: BloomSettings,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniform: wgpu::Buffer,
    prefilter_pipeline: wgpu::RenderPipeline,
    blur_horizontal_pipeline: wgpu::RenderPipeline,
    blur_vertical_pipeline: wgpu::RenderPipeline,
    targets: BloomTargets,
}

pub struct BloomTargets {
    _prefilter: wgpu::Texture,
    _scratch: wgpu::Texture,
    _blurred: wgpu::Texture,
    prefilter_view: wgpu::TextureView,
    scratch_view: wgpu::TextureView,
    blurred_view: wgpu::TextureView,
    prefilter_bind_group: wgpu::BindGroup,
    horizontal_bind_group: wgpu::BindGroup,
    vertical_bind_group: wgpu::BindGroup,
}

impl BloomTargets {
    pub fn output_view(&self) -> &wgpu::TextureView {
        &self.blurred_view
    }
}

impl BloomPass {
    pub fn new(
        device: &wgpu::Device,
        source: &wgpu::TextureView,
        size: PhysicalSize<u32>,
        settings: BloomSettings,
    ) -> Result<Option<Self>, String> {
        let settings = settings.validate()?;
        if !settings.is_active() {
            return Ok(None);
        }
        let layout = create_layout(device);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Deep Engine native bloom linear sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native bloom controls"),
            contents: bytemuck::bytes_of(&BloomUniform {
                threshold: settings.threshold,
                soft_knee: settings.soft_knee,
                radius: settings.radius,
                _padding: 0.0,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native HDR bloom shader v1"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Deep Engine native bloom pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let prefilter_pipeline = create_pipeline(
            device,
            &pipeline_layout,
            &shader,
            "fragment_prefilter",
            "prefilter",
        );
        let blur_horizontal_pipeline = create_pipeline(
            device,
            &pipeline_layout,
            &shader,
            "fragment_blur_horizontal",
            "horizontal blur",
        );
        let blur_vertical_pipeline = create_pipeline(
            device,
            &pipeline_layout,
            &shader,
            "fragment_blur_vertical",
            "vertical blur",
        );
        let targets = BloomTargets::new(device, &layout, &sampler, &uniform, source, size);
        Ok(Some(Self {
            settings,
            layout,
            sampler,
            uniform,
            prefilter_pipeline,
            blur_horizontal_pipeline,
            blur_vertical_pipeline,
            targets,
        }))
    }

    pub fn settings(&self) -> BloomSettings {
        self.settings
    }

    pub fn output_view(&self) -> &wgpu::TextureView {
        &self.targets.blurred_view
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn output_texture(&self) -> &wgpu::Texture {
        &self.targets._blurred
    }

    pub fn prepare_resize(
        &self,
        device: &wgpu::Device,
        source: &wgpu::TextureView,
        size: PhysicalSize<u32>,
    ) -> BloomTargets {
        BloomTargets::new(
            device,
            &self.layout,
            &self.sampler,
            &self.uniform,
            source,
            size,
        )
    }

    pub fn publish_resize(&mut self, targets: BloomTargets) {
        self.targets = targets;
    }

    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        draw_stage(
            encoder,
            "Deep Engine native bloom prefilter pass",
            &self.targets.prefilter_view,
            &self.prefilter_pipeline,
            &self.targets.prefilter_bind_group,
        );
        draw_stage(
            encoder,
            "Deep Engine native bloom horizontal pass",
            &self.targets.scratch_view,
            &self.blur_horizontal_pipeline,
            &self.targets.horizontal_bind_group,
        );
        draw_stage(
            encoder,
            "Deep Engine native bloom vertical pass",
            &self.targets.blurred_view,
            &self.blur_vertical_pipeline,
            &self.targets.vertical_bind_group,
        );
    }
}

impl BloomTargets {
    fn new(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        uniform: &wgpu::Buffer,
        source: &wgpu::TextureView,
        size: PhysicalSize<u32>,
    ) -> Self {
        let extent = wgpu::Extent3d {
            width: size.width.max(1).div_ceil(2),
            height: size.height.max(1).div_ceil(2),
            depth_or_array_layers: 1,
        };
        let prefilter = create_target(device, extent, "prefilter");
        let scratch = create_target(device, extent, "horizontal blur");
        let blurred = create_target(device, extent, "vertical blur");
        let prefilter_view = prefilter.create_view(&Default::default());
        let scratch_view = scratch.create_view(&Default::default());
        let blurred_view = blurred.create_view(&Default::default());
        let prefilter_bind_group = create_bind_group(device, layout, sampler, uniform, source);
        let horizontal_bind_group =
            create_bind_group(device, layout, sampler, uniform, &prefilter_view);
        let vertical_bind_group =
            create_bind_group(device, layout, sampler, uniform, &scratch_view);
        Self {
            _prefilter: prefilter,
            _scratch: scratch,
            _blurred: blurred,
            prefilter_view,
            scratch_view,
            blurred_view,
            prefilter_bind_group,
            horizontal_bind_group,
            vertical_bind_group,
        }
    }
}

fn create_target(device: &wgpu::Device, size: wgpu::Extent3d, stage: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(&format!("Deep Engine native bloom {stage}")),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_COLOR_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

fn create_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    uniform: &wgpu::Buffer,
    source: &wgpu::TextureView,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Deep Engine native bloom stage bindings"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(source),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: uniform.as_entire_binding(),
            },
        ],
    })
}

fn draw_stage(
    encoder: &mut wgpu::CommandEncoder,
    label: &str,
    target: &wgpu::TextureView,
    pipeline: &wgpu::RenderPipeline,
    bindings: &wgpu::BindGroup,
) {
    let attachments = [Some(wgpu::RenderPassColorAttachment {
        view: target,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
            store: wgpu::StoreOp::Store,
        },
    })];
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &attachments,
        ..Default::default()
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bindings, &[]);
    pass.draw(0..3, 0..1);
}
