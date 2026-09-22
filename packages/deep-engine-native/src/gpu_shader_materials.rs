use std::{sync::Arc, time::Duration};

use deep_engine_native::shader_package::{
    ExecutableShaderPackage, ExecutableShaderPass, ShaderPackageGpuExecutor,
};

use crate::{
    gpu_ibl::GpuIblEnvironment,
    gpu_textures::GpuPbrResources,
    player_content::PlayerContent,
    player_shader_plan::{ShaderMaterialFeatures, plan_shader_materials_prepared},
    shadow_map::ShadowMap,
};

pub struct BoundShaderPass {
    pub pipeline: wgpu::RenderPipeline,
    pub frames: Vec<wgpu::BindGroup>,
    pub material: Option<wgpu::BindGroup>,
    pub tangent: bool,
}

pub struct BoundShaderMaterial {
    pub forward: [Option<BoundShaderPass>; 3],
    pub shadow: [Option<BoundShaderPass>; 3],
}

pub struct GpuShaderMaterials {
    /// Compiled packages aligned with `content.shader_packages` order; `None`
    /// marks an isolated (failed-to-compile) package whose dependents fell back
    /// to the standard PBR path.
    _packages: Vec<Option<Arc<ExecutableShaderPackage>>>,
    /// Ids of isolated packages, in submission order — machine-readable evidence.
    pub isolated: Vec<String>,
    /// Materials that fell back to standard PBR because their package failed.
    pub fallback_materials: usize,
    pub materials: Vec<Option<BoundShaderMaterial>>,
    pub signature: String,
}

pub struct ShaderSceneResources<'a> {
    pub pbr: &'a GpuPbrResources,
    pub batches: &'a [deep_engine_native::scene::DrawBatch],
    pub features: &'a [ShaderMaterialFeatures],
    pub frame: &'a wgpu::Buffer,
    pub shadows: &'a ShadowMap,
    pub ibl: &'a GpuIblEnvironment,
}

impl GpuShaderMaterials {
    pub fn content_key(content: &PlayerContent) -> Result<Option<String>, String> {
        use deep_engine_native::runtime_package::runtime_content_sha256;
        if content.shader_packages.is_empty() && content.material_bindings.is_empty() {
            return Ok(None);
        }
        let value = serde_json::to_value((&content.shader_packages, &content.material_bindings))
            .map_err(|error| format!("cannot hash native shader candidate: {error}"))?;
        Ok(Some(runtime_content_sha256(&value)))
    }

    pub fn new(
        device: &wgpu::Device,
        content: &PlayerContent,
        resources: ShaderSceneResources<'_>,
        signature: String,
    ) -> Result<Option<Self>, String> {
        if content.shader_packages.is_empty() && content.material_bindings.is_empty() {
            return Ok(None);
        }
        let plans = plan_shader_materials_prepared(
            content.packet(),
            &content.shader_packages,
            &content.material_bindings,
            resources.batches,
            resources.features,
        )?;
        // Per-package isolation: one broken or incompatible package must not
        // kill the others. Failed entries stay `None` and every material that
        // referenced them falls back to the standard PBR path below.
        let mut executor = ShaderPackageGpuExecutor::default();
        let mut packages: Vec<Option<Arc<ExecutableShaderPackage>>> =
            Vec::with_capacity(content.shader_packages.len());
        let mut isolated = Vec::new();
        let mut fallback_materials = 0usize;
        for package in &content.shader_packages {
            let bytes = serde_json::to_vec(package).map_err(|error| error.to_string())?;
            match executor.prepare_bytes(device, &bytes) {
                Ok(executable) => packages.push(Some(executable)),
                Err(error) => {
                    eprintln!(
                        "native Player package {} isolated, materials fall back to standard PBR: {error}",
                        package.package_id
                    );
                    isolated.push(package.package_id.clone());
                    packages.push(None);
                }
            }
        }
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = (|| {
            let mut materials = Vec::with_capacity(plans.len());
            for (index, plan) in plans.iter().enumerate() {
                let Some(plan) = plan else {
                    materials.push(None);
                    continue;
                };
                let Some(package) = &packages[plan.package_index] else {
                    // Plan referenced an isolated package: standard PBR fallback.
                    fallback_materials += 1;
                    materials.push(None);
                    continue;
                };
                let mut material = BoundShaderMaterial {
                    forward: std::array::from_fn(|_| None),
                    shadow: std::array::from_fn(|_| None),
                };
                for slot in 0..3 {
                    for (ids, target) in [
                        (&plan.forward, &mut material.forward),
                        (&plan.shadow, &mut material.shadow),
                    ] {
                        if let Some(id) = &ids[slot] {
                            let pass = package.pass(id).ok_or_else(|| {
                                format!("compiled package {} lost pass {id}", package.package_id)
                            })?;
                            target[slot] = Some(bind_pass(device, pass, &resources, index)?);
                        }
                    }
                }
                materials.push(Some(material));
            }
            Ok(Self {
                _packages: packages,
                isolated,
                fallback_materials,
                materials,
                signature,
            })
        })();
        let completion = device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(5)),
        });
        let errors = [
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
            pollster::block_on(validation.pop()),
        ];
        completion.map_err(|error| {
            format!("native Player shader resource preparation timed out: {error}")
        })?;
        if let Some(error) = errors.into_iter().flatten().next() {
            return Err(format!(
                "native Player shader material transaction rejected: {error}"
            ));
        }
        candidate.map(Some)
    }
}

fn bind_pass(
    device: &wgpu::Device,
    pass: &ExecutableShaderPass,
    resources: &ShaderSceneResources<'_>,
    material_index: usize,
) -> Result<BoundShaderPass, String> {
    let frame_layout = pass
        .bind_group_layouts
        .first()
        .ok_or("shader pass has no frame layout")?;
    let frame_contract = pass
        .bind_group_contracts
        .iter()
        .find(|layout| layout.group == 0)
        .ok_or("shader pass has no frame contract")?;
    let frames = match frame_contract.id.as_str() {
        "forward-frame" => vec![resources.ibl.create_frame_bind_group(
            device,
            frame_layout,
            resources.frame,
            None,
            resources.shadows,
            // 自定义 shader 合同 layout 没有 probe 槽(native section 之外)。
            None,
            "native package forward frame",
            false,
        )],
        "shadow-frame" => (0..resources.shadows.cascade_count() as usize)
            .map(|cascade| {
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("native package cascade fixed frame"),
                    layout: frame_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &resources.shadows.shadow_frames,
                            offset: u64::from(resources.shadows.dynamic_offset(cascade)),
                            size: wgpu::BufferSize::new(
                                deep_engine_native::mesh_abi::FRAME_UNIFORM_BYTES,
                            ),
                        }),
                    }],
                })
            })
            .collect(),
        id => {
            return Err(format!(
                "native Player cannot bind frame layout {id} for pass {}",
                pass.id
            ));
        }
    };
    let material = if pass.bind_group_layouts.len() > 1 {
        if pass.bind_group_layouts.len() != 2
            || !pass
                .bind_group_contracts
                .iter()
                .any(|layout| layout.group == 1 && layout.id == "material")
        {
            return Err(format!(
                "native Player cannot bind extra resource groups for pass {}",
                pass.id
            ));
        }
        Some(resources.pbr.create_material_bind_group(
            device,
            &pass.bind_group_layouts[1],
            material_index,
        ))
    } else {
        None
    };
    Ok(BoundShaderPass {
        pipeline: pass.pipeline.clone(),
        frames,
        material,
        tangent: pass
            .vertex_streams
            .iter()
            .any(|stream| stream.id == "tangent"),
    })
}
