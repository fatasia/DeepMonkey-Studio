use bytemuck::{bytes_of, cast_slice};
use deep_engine_native::{
    cascaded_shadow::{
        CASCADED_SHADOW_UNIFORM_BYTES, CascadedShadowCamera, CascadedShadowOptions,
        CascadedShadowPlan, plan_cascaded_shadows_for_scene,
    },
    mesh_abi::{FRAME_UNIFORM_BYTES, FrameUniform, SHADOW_FORMAT},
    scene_bounds::SceneWorldBounds,
};
use wgpu::util::DeviceExt;
#[path = "section_bindings.rs"]
mod section_bindings;

pub(crate) const DEPTH_BIAS: f32 = 0.00075;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CascadedShadowGpuMetrics {
    pub cascade_count: u32,
    pub map_size: u32,
    pub depth_texture_bytes: u64,
    pub shadow_frame_stride: u64,
}

pub struct ShadowMap {
    pub(crate) _texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub layer_views: Vec<wgpu::TextureView>,
    pub sampler: wgpu::Sampler,
    pub sampling_uniform: wgpu::Buffer,
    pub section_uniform: wgpu::Buffer,
    pub(crate) shadow_frames: wgpu::Buffer,
    pub shadow_frame_bind_group: wgpu::BindGroup,
    pub(crate) options: CascadedShadowOptions,
    pub(crate) plan: CascadedShadowPlan,
    pub(crate) scene_bounds: Option<SceneWorldBounds>,
    pub(crate) frame_stride: u64,
    pub(crate) local_matrices: Vec<[[f32; 4]; 4]>,
}

pub trait ShadowViewSource {
    fn cascade_count(&self) -> u32;
    fn cascade_view_projection(&self, index: usize) -> [[f32; 4]; 4];
    fn shadow_map_size(&self) -> u32;
    fn shadow_view_count(&self) -> u32 {
        self.cascade_count()
    }
    fn shadow_view_projection(&self, index: usize) -> [[f32; 4]; 4] {
        self.cascade_view_projection(index)
    }
}

impl ShadowMap {
    pub fn new(
        device: &wgpu::Device,
        shadow_frame_layout: &wgpu::BindGroupLayout,
        frame: &FrameUniform,
        camera: CascadedShadowCamera,
        light_direction: [f32; 3],
        scene_bounds: Option<SceneWorldBounds>,
    ) -> Result<Self, String> {
        Self::new_with_options(
            device,
            shadow_frame_layout,
            frame,
            camera,
            light_direction,
            scene_bounds,
            CascadedShadowOptions::default(),
        )
    }

    pub(crate) fn new_with_options(
        device: &wgpu::Device,
        shadow_frame_layout: &wgpu::BindGroupLayout,
        frame: &FrameUniform,
        camera: CascadedShadowCamera,
        light_direction: [f32; 3],
        scene_bounds: Option<SceneWorldBounds>,
        options: CascadedShadowOptions,
    ) -> Result<Self, String> {
        validate_device(device, options)?;
        let plan = plan_cascaded_shadows_for_scene(camera, light_direction, options, scene_bounds)?;
        let sampling_data = plan.uniform(DEPTH_BIAS)?;
        let frame_stride = aligned_frame_stride(device);
        let shadow_frame_data = pack_shadow_frames(frame, &plan, frame_stride);
        let local_matrices = deep_engine_native::local_shadow::frame_matrices(frame);
        let layer_count = options.cascade_count as u32 + local_matrices.len() as u32;
        if layer_count > device.limits().max_texture_array_layers {
            return Err("shadow views exceed device array budget".into());
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native cascaded shadow map"),
            size: wgpu::Extent3d {
                width: options.shadow_map_size,
                height: options.shadow_map_size,
                depth_or_array_layers: layer_count,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: SHADOW_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("Deep Engine native cascaded shadow array view"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            array_layer_count: Some(layer_count),
            aspect: wgpu::TextureAspect::DepthOnly,
            ..Default::default()
        });
        let layer_views = (0..layer_count)
            .map(|layer| {
                texture.create_view(&wgpu::TextureViewDescriptor {
                    label: Some("Deep Engine native cascade layer view"),
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: layer,
                    array_layer_count: Some(1),
                    aspect: wgpu::TextureAspect::DepthOnly,
                    ..Default::default()
                })
            })
            .collect();
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Deep Engine native shadow comparison sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            lod_min_clamp: 0.0,
            lod_max_clamp: 0.0,
            compare: Some(wgpu::CompareFunction::LessEqual),
            anisotropy_clamp: 1,
            border_color: None,
        });
        let sampling_uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native cascaded shadow sampling ABI"),
            contents: cast_slice(&sampling_data),
            usage: wgpu::BufferUsages::UNIFORM
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
        });
        let shadow_frames = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native cascade caster frames"),
            contents: &shadow_frame_data,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let (section_uniform, shadow_frame_bind_group) =
            section_bindings::create(device, shadow_frame_layout, &shadow_frames);
        Ok(Self {
            _texture: texture,
            view,
            layer_views,
            sampler,
            sampling_uniform,
            section_uniform,
            shadow_frames,
            shadow_frame_bind_group,
            options,
            plan,
            scene_bounds,
            frame_stride,
            local_matrices,
        })
    }

    pub fn update(
        &mut self,
        queue: &wgpu::Queue,
        frame: &FrameUniform,
        camera: CascadedShadowCamera,
        light_direction: [f32; 3],
    ) -> Result<(), String> {
        let plan = plan_cascaded_shadows_for_scene(
            camera,
            light_direction,
            self.options,
            self.scene_bounds,
        )?;
        let sampling_data = plan.uniform(DEPTH_BIAS)?;
        let shadow_frame_data = pack_shadow_frames(frame, &plan, self.frame_stride);
        let local_matrices = deep_engine_native::local_shadow::frame_matrices(frame);
        if local_matrices.len() != self.local_matrices.len() {
            return Err("shadow topology requires full renderer replacement".into());
        }
        queue.write_buffer(&self.sampling_uniform, 0, cast_slice(&sampling_data));
        queue.write_buffer(&self.shadow_frames, 0, &shadow_frame_data);
        self.plan = plan;
        self.local_matrices = local_matrices;
        Ok(())
    }

    pub fn dynamic_offset(&self, cascade_index: usize) -> u32 {
        debug_assert!(cascade_index < self.layer_views.len());
        (cascade_index as u64 * self.frame_stride) as u32
    }

    pub fn cascade_count(&self) -> u32 {
        self.plan.cascades.len() as u32
    }

    pub fn cascade_view_projection(&self, cascade_index: usize) -> [[f32; 4]; 4] {
        self.plan.cascades[cascade_index].view_projection
    }

    pub fn metrics(&self) -> CascadedShadowGpuMetrics {
        CascadedShadowGpuMetrics {
            cascade_count: self.cascade_count(),
            map_size: self.options.shadow_map_size,
            depth_texture_bytes: u64::from(self.options.shadow_map_size).pow(2)
                * self.layer_views.len() as u64
                * 4,
            shadow_frame_stride: self.frame_stride,
        }
    }
}

impl ShadowViewSource for ShadowMap {
    fn shadow_view_count(&self) -> u32 {
        self.layer_views.len() as u32
    }
    fn shadow_view_projection(&self, index: usize) -> [[f32; 4]; 4] {
        if index < self.plan.cascades.len() {
            self.plan.cascades[index].view_projection
        } else {
            self.local_matrices[index - self.plan.cascades.len()]
        }
    }
    fn cascade_count(&self) -> u32 {
        self.cascade_count()
    }

    fn cascade_view_projection(&self, index: usize) -> [[f32; 4]; 4] {
        self.cascade_view_projection(index)
    }

    fn shadow_map_size(&self) -> u32 {
        self.options.shadow_map_size
    }
}

fn validate_device(device: &wgpu::Device, options: CascadedShadowOptions) -> Result<(), String> {
    let limits = device.limits();
    if options.shadow_map_size > limits.max_texture_dimension_2d {
        return Err(format!(
            "native CSM map {} exceeds device 2D texture limit {}",
            options.shadow_map_size, limits.max_texture_dimension_2d
        ));
    }
    if options.cascade_count as u32 > limits.max_texture_array_layers {
        return Err(format!(
            "native CSM needs {} array layers, device exposes {}",
            options.cascade_count, limits.max_texture_array_layers
        ));
    }
    if CASCADED_SHADOW_UNIFORM_BYTES > limits.max_uniform_buffer_binding_size {
        return Err("native CSM sampling ABI exceeds the device uniform binding limit".into());
    }
    if limits.max_dynamic_uniform_buffers_per_pipeline_layout == 0 {
        return Err("native CSM requires one dynamic uniform binding".into());
    }
    Ok(())
}

fn aligned_frame_stride(device: &wgpu::Device) -> u64 {
    let alignment = u64::from(device.limits().min_uniform_buffer_offset_alignment.max(1));
    FRAME_UNIFORM_BYTES.div_ceil(alignment) * alignment
}

pub(crate) fn pack_shadow_frames(
    frame: &FrameUniform,
    plan: &CascadedShadowPlan,
    frame_stride: u64,
) -> Vec<u8> {
    let matrices: Vec<_> = plan
        .cascades
        .iter()
        .map(|cascade| cascade.view_projection)
        .chain(deep_engine_native::local_shadow::frame_matrices(frame))
        .collect();
    let mut packed = vec![0; frame_stride as usize * matrices.len()];
    for (index, matrix) in matrices.iter().enumerate() {
        let mut cascade_frame = *frame;
        cascade_frame[4..8].copy_from_slice(matrix);
        let offset = index * frame_stride as usize;
        packed[offset..offset + FRAME_UNIFORM_BYTES as usize]
            .copy_from_slice(bytes_of(&cascade_frame));
    }
    packed
}

#[cfg(test)]
#[path = "shadow_map_tests.rs"]
mod tests;
