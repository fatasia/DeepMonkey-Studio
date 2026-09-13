use bytemuck::cast_slice;
use deep_engine_native::{
    mesh_abi::{FRAME_UNIFORM_BYTES, frame_uniform},
    shader_package::ExecutableShaderPass,
};
use wgpu::util::DeviceExt;

pub struct ProbeResources {
    pub forward_bind_group: wgpu::BindGroup,
    pub shadow_bind_group: wgpu::BindGroup,
    pub geometry: wgpu::Buffer,
    pub instance: wgpu::Buffer,
    _frame: wgpu::Buffer,
    _shadow_map: wgpu::Texture,
    _environment_textures: [wgpu::Texture; 3],
    _samplers: [wgpu::Sampler; 2],
}

impl ProbeResources {
    /// Builds deterministic probe-owned resources that satisfy the frozen ABI.
    /// These validate binding compatibility without claiming ownership of renderer scene data.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        forward: &ExecutableShaderPass,
        shadow: &ExecutableShaderPass,
    ) -> Result<Self, String> {
        require_single_layout(forward, "forward-frame")?;
        require_single_layout(shadow, "shadow-frame")?;
        let frame_data = frame_uniform(1.0, 0.0);
        let frame = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("package probe ABI frame"),
            contents: cast_slice(&frame_data),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        if frame.size() != FRAME_UNIFORM_BYTES {
            return Err("package probe frame does not match the 208-byte ABI".into());
        }

        let shadow_map = create_shadow_map(device);
        let shadow_view = shadow_map.create_view(&Default::default());
        let shadow_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("package probe comparison sampler"),
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });
        let environment_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("package probe environment sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let specular = create_color_texture(
            device,
            queue,
            "package probe specular cube",
            6,
            [64, 96, 128, 255],
        );
        let diffuse = create_color_texture(
            device,
            queue,
            "package probe diffuse cube",
            6,
            [32, 48, 64, 255],
        );
        let brdf = create_color_texture(
            device,
            queue,
            "package probe BRDF LUT",
            1,
            [128, 128, 0, 255],
        );
        let specular_view = cube_view(&specular);
        let diffuse_view = cube_view(&diffuse);
        let brdf_view = brdf.create_view(&Default::default());

        let forward_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("package probe forward ABI bindings"),
            layout: &forward.bind_group_layouts[0],
            entries: &[
                buffer_entry(0, &frame),
                texture_entry(1, &shadow_view),
                sampler_entry(2, &shadow_sampler),
                texture_entry(3, &specular_view),
                texture_entry(4, &diffuse_view),
                texture_entry(5, &brdf_view),
                sampler_entry(6, &environment_sampler),
            ],
        });
        let shadow_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("package probe shadow ABI bindings"),
            layout: &shadow.bind_group_layouts[0],
            entries: &[buffer_entry(0, &frame)],
        });

        let geometry_data: [[f32; 10]; 3] = [
            [-1.0, -1.0, 0.25, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
            [3.0, -1.0, 0.25, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0],
            [-1.0, 3.0, 0.25, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0],
        ];
        let mut instance_data = [0.0_f32; 36];
        instance_data[0] = 1.0;
        instance_data[5] = 1.0;
        instance_data[10] = 1.0;
        instance_data[12] = 1.0;
        instance_data[17] = 1.0;
        instance_data[22] = 1.0;
        let geometry = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("package probe ABI geometry"),
            contents: cast_slice(&geometry_data),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let instance = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("package probe ABI instance"),
            contents: cast_slice(&instance_data),
            usage: wgpu::BufferUsages::VERTEX,
        });
        Ok(Self {
            forward_bind_group,
            shadow_bind_group,
            geometry,
            instance,
            _frame: frame,
            _shadow_map: shadow_map,
            _environment_textures: [specular, diffuse, brdf],
            _samplers: [shadow_sampler, environment_sampler],
        })
    }
}

fn require_single_layout(pass: &ExecutableShaderPass, id: &str) -> Result<(), String> {
    if pass.bind_group_contracts.len() != 1
        || pass.bind_group_contracts[0].id != id
        || pass.bind_group_layouts.len() != 1
    {
        return Err(format!("package probe expected one {id} bind group"));
    }
    Ok(())
}

fn create_shadow_map(device: &wgpu::Device) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("package probe shadow binding"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    })
}

fn create_color_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    layers: u32,
    texel: [u8; 4],
) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: layers,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let bytes = (0..layers).flat_map(|_| texel).collect::<Vec<_>>();
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4),
            rows_per_image: Some(1),
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: layers,
        },
    );
    texture
}

fn cube_view(texture: &wgpu::Texture) -> wgpu::TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor {
        label: Some("package probe cube view"),
        dimension: Some(wgpu::TextureViewDimension::Cube),
        array_layer_count: Some(6),
        ..Default::default()
    })
}

fn buffer_entry<'a>(binding: u32, buffer: &'a wgpu::Buffer) -> wgpu::BindGroupEntry<'a> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

fn texture_entry<'a>(binding: u32, view: &'a wgpu::TextureView) -> wgpu::BindGroupEntry<'a> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::TextureView(view),
    }
}

fn sampler_entry<'a>(binding: u32, sampler: &'a wgpu::Sampler) -> wgpu::BindGroupEntry<'a> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::Sampler(sampler),
    }
}
