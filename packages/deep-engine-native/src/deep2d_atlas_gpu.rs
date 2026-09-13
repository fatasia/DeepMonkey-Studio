use bytemuck::cast_slice;
use deep_engine_native::deep2d::{
    Deep2dAtlasFormat, ImageSampling, PreparedDeep2dAtlas, PreparedDeep2dRuntime,
};
use wgpu::util::DeviceExt;

const SHADER: &str = include_str!("../assets/shaders/native_deep2d_atlas_v1.wgsl");

pub(crate) struct ResidentAtlas {
    _texture: wgpu::Texture,
    pub bind_group: wgpu::BindGroup,
}

pub struct Deep2dAtlasGpuResources {
    pub pipeline: wgpu::RenderPipeline,
    pub vertex_buffer: wgpu::Buffer,
    pub atlases: Vec<ResidentAtlas>,
}

impl Deep2dAtlasGpuResources {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        frame_layout: &wgpu::BindGroupLayout,
        prepared: &PreparedDeep2dRuntime,
    ) -> Result<Self, String> {
        let device_limit = device.limits().max_texture_dimension_2d;
        if let Some(atlas) = prepared
            .atlases
            .iter()
            .find(|atlas| atlas.width > device_limit || atlas.height > device_limit)
        {
            return Err(format!(
                "Deep2d atlas {} exceeds device 2D dimension limit {device_limit}",
                atlas.id
            ));
        }
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native Deep2d atlas shader v1"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let atlas_layout = atlas_layout(device);
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Deep Engine native Deep2d atlas pipeline layout v1"),
            bind_group_layouts: &[Some(frame_layout), Some(&atlas_layout)],
            immediate_size: 0,
        });
        let attributes = wgpu::vertex_attr_array![
            0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32
        ];
        let buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: 36,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &attributes,
        })];
        let targets = [Some(wgpu::ColorTargetState {
            format,
            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::ALL,
        })];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Deep Engine native Deep2d atlas alpha pipeline v1"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &buffers,
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment_main"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview_mask: None,
            cache: None,
        });
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native Deep2d atlas vertices v1"),
            contents: cast_slice(&prepared.atlas_vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let atlases = prepared
            .atlases
            .iter()
            .map(|atlas| upload_atlas(device, queue, &atlas_layout, atlas))
            .collect();
        Ok(Self {
            pipeline,
            vertex_buffer,
            atlases,
        })
    }
}

fn atlas_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native Deep2d atlas texture layout v1"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    })
}

fn upload_atlas(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    layout: &wgpu::BindGroupLayout,
    atlas: &PreparedDeep2dAtlas,
) -> ResidentAtlas {
    let format = match atlas.format {
        Deep2dAtlasFormat::R8Unorm => wgpu::TextureFormat::R8Unorm,
        Deep2dAtlasFormat::Rgba8UnormSrgb => wgpu::TextureFormat::Rgba8UnormSrgb,
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(&atlas.id),
        size: wgpu::Extent3d {
            width: atlas.width,
            height: atlas.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &atlas.data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(atlas.width * atlas.format.bytes_per_pixel() as u32),
            rows_per_image: Some(atlas.height),
        },
        wgpu::Extent3d {
            width: atlas.width,
            height: atlas.height,
            depth_or_array_layers: 1,
        },
    );
    let view = texture.create_view(&Default::default());
    let filter = match atlas.sampling {
        ImageSampling::Nearest => wgpu::FilterMode::Nearest,
        ImageSampling::Linear => wgpu::FilterMode::Linear,
    };
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("Deep2d atlas sampler v1"),
        mag_filter: filter,
        min_filter: filter,
        ..Default::default()
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Deep2d atlas bindings v1"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
    });
    ResidentAtlas {
        _texture: texture,
        bind_group,
    }
}
