// RT 扩展 frame layout 绑定合同:部分窄特性目标只消费普通 frame layout,
// shadow/rt 变体作为双 layout 合同驻留,故模块级放行 dead_code。
#![allow(dead_code)]

use deep_engine_native::{
    cascaded_shadow::CASCADED_SHADOW_UNIFORM_BYTES, mesh_abi::FRAME_UNIFORM_BYTES,
};

/// RT 扩展 frame layout 里的场景 TLAS 槽号;0..9 与普通 frame layout 完全一致。
pub const FRAME_RT_TLAS_BINDING: u32 = 10;

pub struct FrameLayouts {
    pub frame: wgpu::BindGroupLayout,
    pub shadow: wgpu::BindGroupLayout,
    /// RT 扩展 frame layout(全部 frame 条目 + binding 10 AccelerationStructure)。
    /// 仅当选定 device 启用实验性 ray query 时创建;栅格/阴影/探针管线继续
    /// 使用未变的 `frame` layout。采用双 layout 而不是给唯一 layout 加可选槽:
    /// wgpu bind group 必须填满 layout 全部条目,而 wgpu 没有"空 acceleration
    /// structure"占位——把 AS 条目塞进共享 layout 会强迫非 RT 设备与
    /// shadow/IBL 探针也绑定 TLAS,破坏旧路径;双 layout 让栅格管线布局零改动,
    /// RT 槽只在能力就绪且 TLAS 驻留成功时真正绑定。
    pub frame_rt: Option<wgpu::BindGroupLayout>,
}

pub fn create_native_mesh_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native mesh shader v1"),
        source: wgpu::ShaderSource::Wgsl(
            concat!(
                include_str!("../assets/shaders/native_mesh_v1.wgsl"),
                "\n",
                include_str!("../assets/shaders/native_cascaded_shadow_v1.wgsl")
            )
            .into(),
        ),
    })
}

/// F2 RT fragment 拼接模块：与普通 mesh shader 完全同源（本体 + 级联阴影），
/// 仅前置 ray-query 使能行并追加 RT fragment 段（binding 10 TLAS +
/// `fragment_main_rt`，directional 阴影走硬件 Ray Query）。共享同一份
/// mesh/shadow 源保证 vertex 阶段与光栅画面逐位同源；模块内包含
/// `fragment_main_rt` 不影响普通管线继续选择 `fragment_main`。
pub fn create_native_mesh_rt_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native RT mesh fragment shader v1"),
        source: wgpu::ShaderSource::Wgsl(
            concat!(
                "enable wgpu_ray_query;\n",
                include_str!("../assets/shaders/native_mesh_v1.wgsl"),
                "\n",
                include_str!("../assets/shaders/native_cascaded_shadow_v1.wgsl"),
                "\n",
                include_str!("../assets/shaders/native_mesh_rt_fragment_v1.wgsl")
            )
            .into(),
        ),
    })
}

fn section_layout() -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 8,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(16),
        },
        count: None,
    }
}

fn frame_layout_entries() -> Vec<wgpu::BindGroupLayoutEntry> {
    vec![
        section_layout(),
        wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: wgpu::BufferSize::new(FRAME_UNIFORM_BYTES),
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Depth,
                view_dimension: wgpu::TextureViewDimension::D2Array,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::Cube,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 4,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::Cube,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 5,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 6,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 7,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: wgpu::BufferSize::new(CASCADED_SHADOW_UNIFORM_BYTES),
            },
            count: None,
        },
        wgpu::BindGroupLayoutEntry {
            binding: 9,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: wgpu::BufferSize::new(16 * 16),
            },
            count: None,
        },
        // F3:探针 GI storage(96B 记录流)。0..10 既有槽位不动;空场景由
        // probe_gi_storage::disabled_frame_buffer 提供全零占位,开关
        // (frame.lightDirection.w)为 0 时采样分支返回零,旧路径逐位不变。
        // frame 与 frame_rt 双 layout 共用本清单,RT 槽(10)之后追加。
        // 本文件同时被测试 crate 以 #[path] 复编译,必须走 lib 路径。
        wgpu::BindGroupLayoutEntry {
            binding: deep_engine_native::probe_gi_storage::FRAME_PROBE_GI_BINDING,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: wgpu::BufferSize::new(
                    deep_engine_native::probe_gi_storage::PROBE_GI_STORAGE_MIN_BINDING_BYTES,
                ),
            },
            count: None,
        },
        // Native clustered-lighting storage ABI v1. The buffer is always
        // bound (an empty fixed grid when no local lights exist) so frame
        // bind groups remain structurally stable across scene updates.
        wgpu::BindGroupLayoutEntry {
            binding: 12,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: wgpu::BufferSize::new(4 * (4 + 64 * 17)),
            },
            count: None,
        },
    ]
}

fn rt_tlas_layout_entry() -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: FRAME_RT_TLAS_BINDING,
        // 未来两类消费方并存:fragment ray-query(像素路径)与 compute
        // ray-query(探针/GI 生产者);layout 不限制到单一 stage。
        visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::AccelerationStructure {
            vertex_return: false,
        },
        count: None,
    }
}

pub fn create_frame_layouts(device: &wgpu::Device) -> FrameLayouts {
    let frame = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native frame layout"),
        entries: &frame_layout_entries(),
    });
    // RT 扩展 layout 仅在设备真的启用 ray query 时创建:非 RT 设备上
    // AccelerationStructure 条目会直接被 wgpu 校验拒绝。
    let frame_rt = device
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
        .then(|| {
            let mut entries = frame_layout_entries();
            entries.push(rt_tlas_layout_entry());
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Deep Engine native RT frame layout"),
                entries: &entries,
            })
        });
    let shadow = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native shadow frame layout"),
        entries: &[
            section_layout(),
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(FRAME_UNIFORM_BYTES),
                },
                count: None,
            },
        ],
    });
    FrameLayouts {
        frame,
        shadow,
        frame_rt,
    }
}
