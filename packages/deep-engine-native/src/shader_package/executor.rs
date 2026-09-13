use std::{collections::HashMap, fmt, sync::Arc, time::Duration};

use super::{
    DeepShaderPackageV2, ShaderAbiAttachmentProfile, ShaderAbiBindGroupLayout,
    ShaderAbiVertexStream, ShaderPackageError, ShaderPackagePassPlan,
    execution_plan::{ShaderPackageExecutionPlan, plan_validated_shader_package},
    gpu_descriptor, parse_and_validate_shader_package,
};

#[derive(Debug)]
pub enum ShaderPackageExecutionError {
    Package(ShaderPackageError),
    Descriptor(String),
    Gpu(String),
}

impl fmt::Display for ShaderPackageExecutionError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Package(error) => write!(output, "shader package validation failed: {error}"),
            Self::Descriptor(error) => write!(output, "shader package descriptor failed: {error}"),
            Self::Gpu(error) => write!(output, "shader package GPU creation failed: {error}"),
        }
    }
}

impl std::error::Error for ShaderPackageExecutionError {}

impl From<ShaderPackageError> for ShaderPackageExecutionError {
    fn from(value: ShaderPackageError) -> Self {
        Self::Package(value)
    }
}

/// Device-local executable package. The executor owns pipeline/layout handles; the renderer
/// must create bind groups from these exact layouts and attach its real scene resources.
#[derive(Debug)]
pub struct ExecutableShaderPackage {
    pub package_id: String,
    pub package_cache_key: String,
    pub device_epoch: u64,
    pub passes: Vec<ExecutableShaderPass>,
}

impl ExecutableShaderPackage {
    pub fn pass(&self, id: &str) -> Option<&ExecutableShaderPass> {
        self.passes.iter().find(|pass| pass.id == id)
    }
}

#[derive(Debug)]
pub struct ExecutableShaderPass {
    pub id: String,
    pub cache_key: String,
    pub kind: String,
    pub shader_module: wgpu::ShaderModule,
    pub bind_group_layouts: Vec<wgpu::BindGroupLayout>,
    pub bind_group_contracts: Vec<ShaderAbiBindGroupLayout>,
    pub pipeline_layout: wgpu::PipelineLayout,
    pub pipeline: wgpu::RenderPipeline,
    pub vertex_streams: Vec<ShaderAbiVertexStream>,
    pub attachment_profile: ShaderAbiAttachmentProfile,
    pub resolve_required: bool,
}

/// Atomically caches complete packages for one wgpu device generation.
#[derive(Default)]
pub struct ShaderPackageGpuExecutor {
    cache: HashMap<String, Arc<ExecutableShaderPackage>>,
    device_epoch: u64,
}

impl ShaderPackageGpuExecutor {
    pub fn cache_size(&self) -> usize {
        self.cache.len()
    }

    pub fn device_epoch(&self) -> u64 {
        self.device_epoch
    }

    /// Drops cached handles after a device loss or renderer rebuild. Previously returned
    /// `Arc`s remain caller-owned and must not be submitted after their epoch is invalidated.
    pub fn invalidate_device(&mut self) {
        self.device_epoch = self.device_epoch.wrapping_add(1);
        self.cache.clear();
    }

    /// Strictly validates untrusted bytes, then creates every package pipeline.
    /// The cache changes only after every module/layout/pipeline succeeds.
    pub fn prepare_bytes(
        &mut self,
        device: &wgpu::Device,
        bytes: &[u8],
    ) -> Result<Arc<ExecutableShaderPackage>, ShaderPackageExecutionError> {
        let package = parse_and_validate_shader_package(bytes)?;
        if let Some(cached) = self.cache.get(&package.package_cache_key) {
            return Ok(Arc::clone(cached));
        }
        let plan = plan_validated_shader_package(&package)?;
        let candidate = Arc::new(compile_package(device, &package, &plan, self.device_epoch)?);
        self.cache
            .insert(package.package_cache_key.clone(), Arc::clone(&candidate));
        Ok(candidate)
    }
}

fn compile_package(
    device: &wgpu::Device,
    package: &DeepShaderPackageV2,
    plan: &ShaderPackageExecutionPlan,
    device_epoch: u64,
) -> Result<ExecutableShaderPackage, ShaderPackageExecutionError> {
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let candidate = (|| {
        let modules = package
            .modules
            .iter()
            .map(|module| {
                let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(&module.id),
                    source: wgpu::ShaderSource::Wgsl(module.source.as_str().into()),
                });
                (module.id.as_str(), shader)
            })
            .collect::<HashMap<_, _>>();

        let mut passes = Vec::with_capacity(plan.passes.len());
        for pass in &plan.passes {
            let shader_module = modules.get(pass.module_id.as_str()).ok_or_else(|| {
                ShaderPackageExecutionError::Descriptor(format!(
                    "pass {} references missing module {}",
                    pass.id, pass.module_id
                ))
            })?;
            passes.push(compile_pass(device, pass, shader_module)?);
        }
        Ok(ExecutableShaderPackage {
            package_id: plan.package_id.clone(),
            package_cache_key: plan.package_cache_key.clone(),
            device_epoch,
            passes,
        })
    })();

    let poll_error = device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(5)),
        })
        .err()
        .map(|error| error.to_string());
    let internal_error = pollster::block_on(internal_scope.pop());
    let memory_error = pollster::block_on(memory_scope.pop());
    let validation_error = pollster::block_on(validation_scope.pop());
    if let Some(error) = poll_error {
        return Err(ShaderPackageExecutionError::Gpu(format!(
            "device poll failed: {error}"
        )));
    }
    if let Some(error) = validation_error.or(memory_error).or(internal_error) {
        return Err(ShaderPackageExecutionError::Gpu(error.to_string()));
    }
    candidate
}

fn compile_pass(
    device: &wgpu::Device,
    pass: &ShaderPackagePassPlan,
    shader_module: &wgpu::ShaderModule,
) -> Result<ExecutableShaderPass, ShaderPackageExecutionError> {
    let ordered_layouts = ordered_bind_group_layouts(&pass.bind_group_layouts)?;
    let mut bind_group_layouts = Vec::with_capacity(ordered_layouts.len());
    for layout in ordered_layouts {
        let entries = gpu_descriptor::bind_group_entries(layout)
            .map_err(ShaderPackageExecutionError::Descriptor)?;
        bind_group_layouts.push(device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some(&layout.id),
                entries: &entries,
            },
        ));
    }
    let layout_refs = bind_group_layouts.iter().map(Some).collect::<Vec<_>>();
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(&pass.id),
        bind_group_layouts: &layout_refs,
        immediate_size: 0,
    });

    let owned_buffers = gpu_descriptor::vertex_buffers(&pass.vertex_streams)
        .map_err(ShaderPackageExecutionError::Descriptor)?;
    let borrowed_buffers = owned_buffers
        .iter()
        .map(|layout| layout.as_ref().map(|value| value.borrowed()))
        .collect::<Vec<_>>();
    let color_targets = pass
        .attachment_profile
        .color_attachments
        .iter()
        .map(gpu_descriptor::color_target)
        .map(|value| value.map(Some))
        .collect::<Result<Vec<_>, _>>()
        .map_err(ShaderPackageExecutionError::Descriptor)?;
    let depth = &pass.attachment_profile.depth_attachment;
    let depth_stencil = wgpu::DepthStencilState {
        format: gpu_descriptor::texture_format(&depth.format)
            .map_err(ShaderPackageExecutionError::Descriptor)?,
        depth_write_enabled: Some(depth.depth_write_enabled),
        depth_compare: Some(
            gpu_descriptor::compare_function(&depth.depth_compare)
                .map_err(ShaderPackageExecutionError::Descriptor)?,
        ),
        stencil: Default::default(),
        bias: wgpu::DepthBiasState {
            constant: depth.depth_bias,
            slope_scale: depth.depth_bias_slope_scale as f32,
            clamp: 0.0,
        },
    };
    let fragment = pass
        .fragment_entry_point
        .as_deref()
        .map(|entry_point| wgpu::FragmentState {
            module: shader_module,
            entry_point: Some(entry_point),
            compilation_options: Default::default(),
            targets: &color_targets,
        });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(&pass.id),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader_module,
            entry_point: Some(&pass.vertex_entry_point),
            compilation_options: Default::default(),
            buffers: &borrowed_buffers,
        },
        primitive: gpu_descriptor::primitive_state(&pass.raster_mode)
            .map_err(ShaderPackageExecutionError::Descriptor)?,
        depth_stencil: Some(depth_stencil),
        multisample: wgpu::MultisampleState {
            count: pass.attachment_profile.sample_count,
            ..Default::default()
        },
        fragment,
        multiview_mask: None,
        cache: None,
    });
    Ok(ExecutableShaderPass {
        id: pass.id.clone(),
        cache_key: pass.cache_key.clone(),
        kind: pass.kind.clone(),
        shader_module: shader_module.clone(),
        bind_group_layouts,
        bind_group_contracts: pass.bind_group_layouts.clone(),
        pipeline_layout,
        pipeline,
        vertex_streams: pass.vertex_streams.clone(),
        attachment_profile: pass.attachment_profile.clone(),
        resolve_required: pass.resolve_required,
    })
}

fn ordered_bind_group_layouts(
    layouts: &[ShaderAbiBindGroupLayout],
) -> Result<Vec<&ShaderAbiBindGroupLayout>, ShaderPackageExecutionError> {
    let mut ordered = layouts.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|layout| layout.group);
    if ordered
        .iter()
        .enumerate()
        .any(|(index, layout)| layout.group != index as u32)
    {
        return Err(ShaderPackageExecutionError::Descriptor(
            "bind groups must be contiguous from group zero".into(),
        ));
    }
    Ok(ordered)
}
