//! Native hardware ray-query primitives for wgpu 30.
//!
//! This module intentionally owns only the device-facing acceleration-structure
//! setup.  The renderer can bind the returned TLAS to a ray-query WGSL pass;
//! CPU BVH tracing remains in [`crate::ray_backend`].

use wgpu::util::DeviceExt;

/// Minimal native-only inline ray-query pass. The extension is intentionally
/// kept out of the regular mesh shaders: adapters without the experimental
/// feature continue compiling the normal raster path.
pub const HARDWARE_RAY_QUERY_WGSL: &str = r#"enable wgpu_ray_query;
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read_write> hit: array<u32>;

@compute @workgroup_size(1)
fn main() {
    var rq: ray_query;
    let origin = vec3<f32>(0.0, 0.0, 2.0);
    let direction = vec3<f32>(0.0, 0.0, -1.0);
    rayQueryInitialize(&rq, scene, RayDesc(0u, 0xFFu, 0.001, 1000.0, origin, direction));
    while (rayQueryProceed(&rq)) {}
    let intersection = rayQueryGetCommittedIntersection(&rq);
    hit[0] = select(0u, 1u, intersection.kind != RAY_QUERY_INTERSECTION_NONE);
}
"#;

/// Returns true only when both the selected adapter and the created device
/// expose the experimental ray-query feature. Keeping this contract here lets
/// diagnostics and the future renderer consumer make the same decision.
pub fn ray_query_device_ready(
    adapter_features: wgpu::Features,
    device_features: wgpu::Features,
) -> bool {
    let feature = wgpu::Features::EXPERIMENTAL_RAY_QUERY;
    adapter_features.contains(feature) && device_features.contains(feature)
}

pub fn create_ray_query_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("native hardware ray-query shader"),
        source: wgpu::ShaderSource::Wgsl(HARDWARE_RAY_QUERY_WGSL.into()),
    })
}

pub fn create_ray_query_probe_pipeline(
    device: &wgpu::Device,
    bind_layout: &wgpu::BindGroupLayout,
) -> wgpu::ComputePipeline {
    let shader = create_ray_query_shader(device);
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("native hardware ray-query pipeline layout"),
        bind_group_layouts: &[Some(bind_layout)],
        immediate_size: 0,
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("native hardware ray-query probe pipeline"),
        layout: Some(&layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    })
}

pub fn ray_query_probe_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("native hardware ray-query probe layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::AccelerationStructure {
                    vertex_return: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(4),
                },
                count: None,
            },
        ],
    })
}

/// Encodes one real hardware query dispatch. The caller submits the encoder
/// after the BLAS/TLAS build command and maps `result` to inspect hit[0].
pub fn encode_ray_query_probe(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    scene: &HardwareRayScene,
    result: &wgpu::Buffer,
) {
    encode_ray_query_for_tlas(device, encoder, &scene.tlas, result);
}

/// Same single-ray dispatch as [`encode_ray_query_probe`], but binds any TLAS.
/// The resident-scene tests and future compute consumers share this bind-group
/// layout so the probe cannot drift from production bindings.
pub fn encode_ray_query_for_tlas(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    tlas: &wgpu::Tlas,
    result: &wgpu::Buffer,
) {
    let layout = ray_query_probe_layout(device);
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("native hardware ray-query probe bindings"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: tlas.as_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: result.as_entire_binding(),
            },
        ],
    });
    let pipeline = create_ray_query_probe_pipeline(device, &layout);
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("native hardware ray-query probe pass"),
        timestamp_writes: None,
    });
    pass.set_pipeline(&pipeline);
    pass.set_bind_group(0, &bind_group, &[]);
    pass.dispatch_workgroups(1, 1, 1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use wgpu::util::DeviceExt;

    #[test]
    fn ray_query_device_ready_requires_adapter_and_device_feature() {
        let feature = wgpu::Features::EXPERIMENTAL_RAY_QUERY;
        assert!(!ray_query_device_ready(feature, wgpu::Features::empty()));
        assert!(!ray_query_device_ready(wgpu::Features::empty(), feature));
        // 双双缺失(F2 回退切片):真实无 RT 设备上适配器与设备都不带特征,
        // 能力判定必须 fail-closed 为 false——这是 renderer 侧一切降级决策
        // (frame_rt layout 不创建、驻留不建、帧循环回退栅格)的源头。
        assert!(!ray_query_device_ready(
            wgpu::Features::empty(),
            wgpu::Features::empty()
        ));
        assert!(ray_query_device_ready(feature, feature));
    }

    #[test]
    fn blas_and_tlas_builds_fail_closed_on_device_without_ray_query_feature() {
        // F2 回退切片的真机降级设备:同一适配器创建一台**不带** ray-query
        // 特征的 device(本机适配器支持 RT,但该 device 与真实无 RT 设备
        // 走同一条 `device.features()` 判定路径)。驻留原语必须在触碰任何
        // 资源之前 fail-closed 返回 MissingFeature,renderer 据此把驻留槽
        // 保持为空并逐帧回退栅格。
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let Some(adapter) = pollster::block_on(instance.request_adapter(&Default::default())).ok()
        else {
            return;
        };
        let (device, _queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .expect("adapter must create a plain device");
        assert!(
            !device
                .features()
                .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
            "premise: the plain device must not carry the ray-query feature"
        );
        // 注意:无特征设备上连 BLAS_INPUT usage 的缓冲都无法创建(wgpu
        // 设备校验直接拒绝——gpu_scene 几何缓冲条件附加 BLAS_INPUT 的依据,
        // 见 F2 回退切片)。这里用普通 usage 缓冲仅为走到构建入口的特征门:
        // 门在触碰任何几何之前就拒绝,缓冲内容不会被读。
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("no-ray-query BLAS input vertices"),
            contents: bytemuck::cast_slice(&[[0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("no-ray-query BLAS input indices"),
            contents: bytemuck::cast_slice(&[0u32, 1, 2]),
            usage: wgpu::BufferUsages::INDEX,
        });
        assert!(matches!(
            build_resident_blas_set(
                &device,
                &[ResidentBlasGeometry {
                    vertex_buffer: &vertex_buffer,
                    index_buffer: &index_buffer,
                    vertex_count: 3,
                    index_count: 3,
                }],
            ),
            Err(HardwareRayError::MissingFeature)
        ));
        // TLAS 构建:特征门同样在实例校验之前(传空实例即可验证门本身,
        // 无特征设备上根本无法创建 Blas 资源)。
        assert!(matches!(
            build_tlas_from_blas(&device, &[]),
            Err(HardwareRayError::MissingFeature)
        ));
    }

    #[test]
    fn resident_blas_geometry_validation_rejects_empty_and_malformed_counts() {
        assert_eq!(
            validate_buffer_geometry(0, 3, RESIDENT_VERTEX_STRIDE),
            Err(HardwareRayError::InvalidGeometry)
        );
        assert_eq!(
            validate_buffer_geometry(3, 0, RESIDENT_VERTEX_STRIDE),
            Err(HardwareRayError::InvalidGeometry)
        );
        assert_eq!(
            validate_buffer_geometry(3, 4, RESIDENT_VERTEX_STRIDE),
            Err(HardwareRayError::InvalidGeometry)
        );
    }

    #[test]
    fn resident_blas_geometry_validation_requires_position_safe_stride() {
        assert_eq!(
            validate_buffer_geometry(3, 3, 8),
            Err(HardwareRayError::InvalidGeometry)
        );
        assert_eq!(
            validate_buffer_geometry(3, 3, 10),
            Err(HardwareRayError::InvalidGeometry)
        );
        assert_eq!(
            validate_buffer_geometry(3, 3, RESIDENT_VERTEX_STRIDE),
            Ok(())
        );
    }

    #[test]
    fn selected_gpu_ray_query_probe_returns_a_binary_hit() {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let Some(adapter) = pollster::block_on(instance.request_adapter(&Default::default())).ok()
        else {
            return;
        };
        if !adapter
            .features()
            .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
        {
            return;
        }
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
            experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
            required_limits: {
                let available = adapter.limits();
                wgpu::Limits {
                    max_blas_primitive_count: available.max_blas_primitive_count,
                    max_blas_geometry_count: available.max_blas_geometry_count,
                    max_tlas_instance_count: available.max_tlas_instance_count,
                    max_acceleration_structures_per_shader_stage: available
                        .max_acceleration_structures_per_shader_stage,
                    max_buffers_and_acceleration_structures_per_shader_stage: available
                        .max_buffers_and_acceleration_structures_per_shader_stage,
                    ..Default::default()
                }
            },
            ..Default::default()
        }))
        .expect("RT-capable adapter must create a ray-query device");
        let (scene, mut encoder) = build_triangle_scene(&device).expect("ray scene");
        let result = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("hardware ray-query test result"),
            contents: bytemuck::cast_slice(&[0u32]),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("hardware ray-query test readback"),
            size: 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_buffer_to_buffer(&result, 0, &readback, 0, 4);
        // The dispatch is encoded after the build in a second encoder so the
        // build/dispatch ordering is explicit at queue submission time.
        queue.submit([encoder.finish()]);
        let mut probe_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("hardware ray-query probe"),
        });
        encode_ray_query_probe(&device, &mut probe_encoder, &scene, &result);
        probe_encoder.copy_buffer_to_buffer(&result, 0, &readback, 0, 4);
        queue.submit([probe_encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let (tx, rx) = mpsc::channel();
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                tx.send(result).ok();
            });
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        rx.recv().unwrap().expect("ray-query readback");
        let mapped = readback
            .slice(..)
            .get_mapped_range()
            .expect("mapped readback");
        let value = bytemuck::from_bytes::<u32>(&mapped);
        assert_eq!(
            *value, 1,
            "hardware ray query did not hit the indexed triangle"
        );
    }
}

/// A device-backed BLAS/TLAS pair containing one indexed triangle.
pub struct HardwareRayScene {
    pub blas: wgpu::Blas,
    pub tlas: wgpu::Tlas,
    _vertex: wgpu::Buffer,
    _index: wgpu::Buffer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardwareRayError {
    MissingFeature,
    InvalidGeometry,
}

/// The resident Native mesh layout is ten `f32` values per vertex.
const RESIDENT_VERTEX_STRIDE: u64 = 40;

fn validate_buffer_geometry(
    vertex_count: u32,
    index_count: u32,
    vertex_stride: u64,
) -> Result<(), HardwareRayError> {
    // BLAS triangle geometry is indexed by complete triangles.  Treat zero
    // counts as an empty/null geometry and reject it before touching wgpu.
    if vertex_count == 0
        || index_count == 0
        || !index_count.is_multiple_of(3)
        || vertex_stride < std::mem::size_of::<[f32; 3]>() as u64
        || !vertex_stride.is_multiple_of(std::mem::align_of::<f32>() as u64)
    {
        return Err(HardwareRayError::InvalidGeometry);
    }
    Ok(())
}

/// Builds a TLAS over already-created BLAS resources. The caller owns the
/// geometry/BLAS lifetimes and must submit each BLAS build before submitting
/// the returned TLAS build encoder. Keeping this operation separate lets the
/// renderer reuse resident `GpuGeometry` buffers and rebuild only instance
/// transforms when the scene changes.
pub fn build_tlas_from_blas(
    device: &wgpu::Device,
    instances: &[(&wgpu::Blas, [f32; 12], u32, u8)],
) -> Result<(wgpu::Tlas, wgpu::CommandEncoder), HardwareRayError> {
    if !device
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
    {
        return Err(HardwareRayError::MissingFeature);
    }
    if instances.is_empty() || instances.len() > u32::MAX as usize {
        return Err(HardwareRayError::InvalidGeometry);
    }
    let tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("hardware-ray-query scene TLAS"),
        max_instances: instances.len() as u32,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    let mut tlas = tlas;
    for (slot, (blas, transform, custom_index, mask)) in instances.iter().enumerate() {
        tlas[slot] = Some(wgpu::TlasInstance::new(
            blas,
            *transform,
            *custom_index,
            *mask,
        ));
    }
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("hardware-ray-query scene TLAS build encoder"),
    });
    encoder.build_acceleration_structures(std::iter::empty::<&wgpu::BlasBuildEntry>(), [&tlas]);
    Ok((tlas, encoder))
}

/// One resident geometry to turn into a BLAS. Buffers must be the production
/// GpuGeometry layout: ten `f32` per vertex (40-byte stride) with `BLAS_INPUT`
/// usage and a u32 index buffer.
pub struct ResidentBlasGeometry<'a> {
    pub vertex_buffer: &'a wgpu::Buffer,
    pub index_buffer: &'a wgpu::Buffer,
    pub vertex_count: u32,
    pub index_count: u32,
}

/// Builds one BLAS per geometry over already-resident buffers in a single
/// encoder.  No TLAS is involved here: the renderer pairs the returned BLAS
/// cache with instance transforms via [`build_tlas_from_blas`] and rebuilds
/// only that TLAS when instances move, so geometry uploads and BLAS builds
/// happen exactly once per geometry revision.
pub fn build_resident_blas_set(
    device: &wgpu::Device,
    geometries: &[ResidentBlasGeometry<'_>],
) -> Result<(Vec<wgpu::Blas>, wgpu::CommandEncoder), HardwareRayError> {
    if !device
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
    {
        return Err(HardwareRayError::MissingFeature);
    }
    if geometries.is_empty() {
        return Err(HardwareRayError::InvalidGeometry);
    }
    struct PreparedGeometry<'a> {
        blas: wgpu::Blas,
        size: wgpu::BlasTriangleGeometrySizeDescriptor,
        vertex_buffer: &'a wgpu::Buffer,
        index_buffer: &'a wgpu::Buffer,
    }
    let mut prepared = Vec::with_capacity(geometries.len());
    for geometry in geometries {
        validate_buffer_geometry(
            geometry.vertex_count,
            geometry.index_count,
            RESIDENT_VERTEX_STRIDE,
        )?;
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: geometry.vertex_count,
            index_format: Some(wgpu::IndexFormat::Uint32),
            index_count: Some(geometry.index_count),
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("hardware-ray-query resident geometry BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        prepared.push(PreparedGeometry {
            blas,
            size,
            vertex_buffer: geometry.vertex_buffer,
            index_buffer: geometry.index_buffer,
        });
    }
    let entries: Vec<wgpu::BlasBuildEntry> = prepared
        .iter()
        .map(|geometry| wgpu::BlasBuildEntry {
            blas: &geometry.blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &geometry.size,
                vertex_buffer: geometry.vertex_buffer,
                first_vertex: 0,
                vertex_stride: RESIDENT_VERTEX_STRIDE,
                index_buffer: Some(geometry.index_buffer),
                first_index: Some(0),
                transform_buffer: None,
                transform_buffer_offset: None,
            }]),
        })
        .collect();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("hardware-ray-query resident BLAS build encoder"),
    });
    encoder.build_acceleration_structures(&entries, std::iter::empty::<&wgpu::Tlas>());
    Ok((
        prepared.into_iter().map(|geometry| geometry.blas).collect(),
        encoder,
    ))
}

/// Builds a real native acceleration structure using wgpu's experimental
/// hardware ray-query path.  The caller must submit the returned encoder before
/// using the TLAS in a shader.
pub fn build_triangle_scene(
    device: &wgpu::Device,
) -> Result<(HardwareRayScene, wgpu::CommandEncoder), HardwareRayError> {
    build_indexed_scene(
        device,
        &[-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0],
        &[0, 1, 2],
        [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    )
}

/// Builds one scene geometry from the same position/index streams used by the
/// Native render packet. Positions are tightly packed xyz; indices are u32.
/// The transform is the TLAS instance's row-major affine 3x4 matrix.
pub fn build_indexed_scene(
    device: &wgpu::Device,
    positions: &[f32],
    indices: &[u32],
    transform: [f32; 12],
) -> Result<(HardwareRayScene, wgpu::CommandEncoder), HardwareRayError> {
    if !device
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
    {
        return Err(HardwareRayError::MissingFeature);
    }
    if !positions.len().is_multiple_of(3)
        || !indices.len().is_multiple_of(3)
        || indices.is_empty()
        || indices
            .iter()
            .any(|index| (*index as usize) >= positions.len() / 3)
    {
        return Err(HardwareRayError::InvalidGeometry);
    }
    let vertex: Vec<[f32; 3]> = positions
        .chunks_exact(3)
        .map(|v| [v[0], v[1], v[2]])
        .collect();
    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("hardware-ray-query triangle vertices"),
        contents: bytemuck::cast_slice(&vertex),
        usage: wgpu::BufferUsages::BLAS_INPUT,
    });
    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("hardware-ray-query triangle indices"),
        contents: bytemuck::cast_slice(indices),
        usage: wgpu::BufferUsages::BLAS_INPUT,
    });
    build_indexed_scene_from_buffers_with_stride(
        device,
        &vertex_buffer,
        &index_buffer,
        vertex.len() as u32,
        indices.len() as u32,
        12,
        transform,
    )
}

/// Builds acceleration structures directly over existing resident geometry
/// buffers. This is the production path used after `GpuGeometry` creation.
pub fn build_indexed_scene_from_buffers(
    device: &wgpu::Device,
    vertex_buffer: &wgpu::Buffer,
    index_buffer: &wgpu::Buffer,
    vertex_count: u32,
    index_count: u32,
    transform: [f32; 12],
) -> Result<(HardwareRayScene, wgpu::CommandEncoder), HardwareRayError> {
    // GpuGeometry stores ten f32 values per vertex (position, normal, uv0,
    // uv1), hence a 40-byte stride.  The public resident-buffer helper is
    // intentionally aligned with that production layout.
    build_indexed_scene_from_buffers_with_stride(
        device,
        vertex_buffer,
        index_buffer,
        vertex_count,
        index_count,
        RESIDENT_VERTEX_STRIDE,
        transform,
    )
}

fn build_indexed_scene_from_buffers_with_stride(
    device: &wgpu::Device,
    vertex_buffer: &wgpu::Buffer,
    index_buffer: &wgpu::Buffer,
    vertex_count: u32,
    index_count: u32,
    vertex_stride: u64,
    transform: [f32; 12],
) -> Result<(HardwareRayScene, wgpu::CommandEncoder), HardwareRayError> {
    if !device
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
    {
        return Err(HardwareRayError::MissingFeature);
    }
    validate_buffer_geometry(vertex_count, index_count, vertex_stride)?;
    // The only supported layouts are the resident ten-float mesh and the
    // legacy tightly-packed xyz test path.
    if vertex_stride != RESIDENT_VERTEX_STRIDE && vertex_stride != 12 {
        return Err(HardwareRayError::InvalidGeometry);
    }
    let geometry_size = wgpu::BlasGeometrySizeDescriptors::Triangles {
        descriptors: vec![wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count,
            index_format: Some(wgpu::IndexFormat::Uint32),
            index_count: Some(index_count),
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        }],
    };
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("hardware-ray-query triangle BLAS"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        geometry_size.clone(),
    );
    let tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("hardware-ray-query triangle TLAS"),
        max_instances: 1,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    let mut tlas = tlas;
    tlas[0] = Some(wgpu::TlasInstance::new(&blas, transform, 0, 0xff));
    let blas_entry = wgpu::BlasBuildEntry {
        blas: &blas,
        geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
            size: match &geometry_size {
                wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors } => &descriptors[0],
                _ => unreachable!(),
            },
            vertex_buffer,
            first_vertex: 0,
            vertex_stride,
            index_buffer: Some(index_buffer),
            first_index: Some(0),
            transform_buffer: None,
            transform_buffer_offset: None,
        }]),
    };
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("hardware-ray-query build encoder"),
    });
    encoder.build_acceleration_structures([&blas_entry], [&tlas]);
    Ok((
        HardwareRayScene {
            blas,
            tlas,
            _vertex: vertex_buffer.clone(),
            _index: index_buffer.clone(),
        },
        encoder,
    ))
}
