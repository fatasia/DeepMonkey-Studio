//! R4 生产接线:MSAA 深度 resolve → HiZ 金字塔(r32float,min 缩减,标准 Z)。
//!
//! 消费链(docs/specs/r4-occlusion-culling-2026-09-20.md §2.2)已就绪等待本输入:
//! 本模块产出 [`OcclusionSource`] 契约的真实纹理——r32float 2D mip 链,
//! 第 0 层 = 主视锥全分辨率深度(min over 4x MSAA 样本),第 i 层 = 上一层的
//! min 缩减,一路降到 1×1(层数公式与 webgpu 侧 `hiZPyramid.ts` 一致)。
//!
//! 转换方案(§1 审计结论):
//! - `copy_texture` 不可行:multisampled 纹理禁 COPY_SRC,且 Depth24Plus→r32float
//!   格式不一致;wgpu render pass 的 `resolve_target` 只支持颜色,深度无法 resolve。
//! - 因此第 0 层用一次全屏 render pass:采样 `texture_depth_multisampled_2d`,
//!   4 样本定序 min,颜色写入 r32float mip 0(免中间 depth32float 纹理与
//!   frag_depth 移植坑;`native_hi_z_extract_v1.wgsl` 手写,理由见该文件头)。
//! - 第 1 级起直接 `include_str!` 复用已认证的 DCIR 工件文本
//!   (`dcir_hi_z_first_stage_min_v1.wgsl` / `dcir_hi_z_variable_reduce_min_v1.wgsl`),
//!   不改 shader 文本;anchored/variable 选择规则与 TS `encodePasses` 一致
//!   (源 even×even → anchored,否则 variable)。
//!
//! 帧序合同:HiZ 在 opaque 后提取(深度已完整;transparent 深度不写入),
//! 遮挡判定 dispatch 在下一帧的 `GpuCulling::encode`(SceneResources 段)——
//! 即「消费上一帧金字塔」,与 TS `previousHiZVisibility` 语义一致。
//! 金字塔在创建/重建时全链填充远平面(1.0):否则第一帧 dispatch 读到
//! wgpu 零初始化(0.0 = 最近)会整体误剔(真实窗口冒烟实测 visible=1/3)。
//! 边界(如实):上一帧深度滞尾意味着相机大幅前推时存在滞后误剔窗口,
//! 1e-6 裕量不覆盖运动补偿;定档与补偿属精度-召回联测切片。
//!
//! 确定性纪律(docs/specs/r2-shader-ir-design-2026-09-19.md §4):
//! 全步定序(min 按固定次序展开)、无原子、无共享内存;±0 由缩减链内核
//! `select(v, 0.0, v == 0.0)` 规范化为 +0。
//!
//! 边界(如实):遮挡判定内核已按足迹逐实例定档(顶层为上限,TS
//! `hiZOcclusionMip` 同式,见 `gpu_occlusion.rs`);精度-召回联测继续通过
//! 显式关闭开关保留回退路径。默认 auto 使用相机变化后一帧保守旁路，避免
//! 旧金字塔误剔，同时让零配置 Native 默认获得遮挡收益。
//! WebGL2 无此路径(native 渲染器仅原生后端,r32float
//! RENDER_ATTACHMENT 在 Vulkan/D3D12/Metal 均可用)。

use wgpu::util::DeviceExt;

use crate::gpu_occlusion::OcclusionSource;

/// 与 TS `HI_Z_WORKGROUP_SIZE` 一致。
pub(crate) const HI_Z_WORKGROUP_SIZE: u32 = 8;
/// 金字塔格式:消费链 OcclusionSource 契约(非 filterable float,storage 写)。
const HI_Z_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Float;

/// 层数 = floor(log2(max(w,h))) + 1,与 TS `hiZMipLevelCount` 逐值一致。
pub(crate) fn hi_z_mip_level_count(width: u32, height: u32) -> u32 {
    let largest = width.max(height).max(1);
    32 - largest.leading_zeros()
}

/// 缩减内核选择,与 TS `encodePasses` 规则一致:源 even×even → anchored。
pub(crate) fn reduce_is_anchored(source_width: u32, source_height: u32) -> bool {
    source_width.is_multiple_of(2) && source_height.is_multiple_of(2)
}

/// Native Hi-Z 运行模式。
///
/// `auto`/未设置是生产默认：挂载遮挡链，并在相机视锥变化后保守旁路一帧。
/// `0`/`off` 用于诊断与回退，`1`/`on` 用于显式强制开启；未知值按 auto 处理，
/// 避免配置拼写错误让用户意外退回全量绘制。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OcclusionHizMode {
    Auto,
    Enabled,
    Disabled,
}

pub(crate) fn parse_occlusion_hiz_mode(value: Option<&str>) -> OcclusionHizMode {
    match value.map(|raw| raw.trim().to_ascii_lowercase()).as_deref() {
        Some("0" | "off" | "false" | "disable" | "disabled") => OcclusionHizMode::Disabled,
        Some("1" | "on" | "true" | "force" | "enabled") => OcclusionHizMode::Enabled,
        _ => OcclusionHizMode::Auto,
    }
}

pub(crate) fn occlusion_hiz_mode() -> OcclusionHizMode {
    parse_occlusion_hiz_mode(
        std::env::var("DEEP_ENGINE_NATIVE_OCCLUSION_HIZ")
            .ok()
            .as_deref(),
    )
}

pub(crate) fn occlusion_hiz_enabled() -> bool {
    occlusion_hiz_mode() != OcclusionHizMode::Disabled
}

/// mip 尺寸,与 TS `mipDimension` 一致:max(1, size >> level)。
pub(crate) fn mip_dimension(size: u32, level: u32) -> u32 {
    size.checked_shr(level).unwrap_or(0).max(1)
}

/// CPU 参考缩减(DCIR 变窗合同的精确语义):目标 texel (tx,ty) 覆盖源窗口
/// x ∈ [floor(tx·sw/tw), floor(((tx+1)·sw+tw−1)/tw)),y 同构;anchored(even×even)
/// 恰为 2×2 块。±0 规范化与内核 `select(v, 0.0, v == 0.0)` 一致。
#[cfg(test)]
pub(crate) fn reference_reduce(source: &[f32], source_width: u32, source_height: u32) -> Vec<f32> {
    let target_width = mip_dimension(source_width, 1);
    let target_height = mip_dimension(source_height, 1);
    let window = |tx: u32, sw: u32, tw: u32| {
        let begin = tx * sw / tw;
        let end = ((tx + 1) * sw).div_ceil(tw);
        begin..end.min(sw)
    };
    let mut target = Vec::with_capacity((target_width * target_height) as usize);
    for ty in 0..target_height {
        for tx in 0..target_width {
            let mut value = f32::INFINITY;
            for y in window(ty, source_height, target_height) {
                for x in window(tx, source_width, target_width) {
                    value = value.min(source[(y * source_width + x) as usize]);
                }
            }
            // ±0 规范化(与 DCIR 内核一致)。
            target.push(if value == 0.0 { 0.0 } else { value });
        }
    }
    target
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ReduceUniforms {
    source_size: [u32; 2],
    target_size: [u32; 2],
}

/// HiZ 金字塔:提取 render pipeline + DCIR 缩减 compute pipelines + 纹理链。
pub(crate) struct HiZPyramid {
    // texture / chain_view / reduce_uniforms 由 bind group 隐式引用,字段
    // 持有所有权保证存续;本体只在测试 readback / 上传路径直接触碰。
    #[allow(dead_code)]
    texture: wgpu::Texture,
    /// 全 mip 链视图(OcclusionSource 用;判定内核按绝对层号采样)。
    chain_view: wgpu::TextureView,
    level_views: Vec<wgpu::TextureView>,
    extract_bind_group: wgpu::BindGroup,
    extract_pipeline: wgpu::RenderPipeline,
    reduce_bind_groups: Vec<wgpu::BindGroup>,
    #[allow(dead_code)]
    reduce_uniforms: Vec<wgpu::Buffer>,
    anchored_pipeline: wgpu::ComputePipeline,
    variable_pipeline: wgpu::ComputePipeline,
    width: u32,
    height: u32,
    mip_level_count: u32,
}

impl HiZPyramid {
    pub(crate) fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        depth_view: &wgpu::TextureView,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("native Hi-Z pyramid requires nonempty dimensions".into());
        }
        let mip_level_count = hi_z_mip_level_count(width, height);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep Engine native Hi-Z pyramid"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: HI_Z_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let chain_view = texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("Deep Engine native Hi-Z chain view"),
            ..Default::default()
        });
        let level_views = (0..mip_level_count)
            .map(|level| {
                texture.create_view(&wgpu::TextureViewDescriptor {
                    label: Some("Deep Engine native Hi-Z mip"),
                    format: Some(HI_Z_FORMAT),
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_mip_level: level,
                    mip_level_count: Some(1),
                    ..Default::default()
                })
            })
            .collect::<Vec<_>>();

        let extract_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Deep Engine native Hi-Z extract layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: true,
                },
                count: None,
            }],
        });
        let extract_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native Hi-Z extract shader v1"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../assets/shaders/native_hi_z_extract_v1.wgsl").into(),
            ),
        });
        let extract_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Deep Engine native Hi-Z extract pipeline layout"),
                bind_group_layouts: &[Some(&extract_layout)],
                immediate_size: 0,
            });
        let extract_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Deep Engine native Hi-Z extract pipeline"),
            layout: Some(&extract_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &extract_module,
                entry_point: Some("vs_extract"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &extract_module,
                entry_point: Some("fs_extract"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: HI_Z_FORMAT,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let extract_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native Hi-Z extract bindings"),
            layout: &extract_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(depth_view),
            }],
        });

        let reduce_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Deep Engine native Hi-Z reduce layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: HI_Z_FORMAT,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let make_reduce_pipeline =
            |label: &'static str, wgsl: &'static str, entry: &'static str| {
                let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(label),
                    source: wgpu::ShaderSource::Wgsl(wgsl.into()),
                });
                let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Deep Engine native Hi-Z reduce pipeline layout"),
                    bind_group_layouts: &[Some(&reduce_layout)],
                    immediate_size: 0,
                });
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(label),
                    layout: Some(&layout),
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    cache: None,
                })
            };
        // DCIR 已认证工件文本逐字复用(include_str!,不改变 shader 文本)。
        let anchored_pipeline = make_reduce_pipeline(
            "Deep Engine native Hi-Z anchored reduce",
            include_str!("../../assets/shaders/dcir_hi_z_first_stage_min_v1.wgsl"),
            "hi_z_first_stage",
        );
        let variable_pipeline = make_reduce_pipeline(
            "Deep Engine native Hi-Z variable reduce",
            include_str!("../../assets/shaders/dcir_hi_z_variable_reduce_min_v1.wgsl"),
            "hi_z_variable_reduce",
        );

        let mut reduce_bind_groups = Vec::with_capacity(mip_level_count.saturating_sub(1) as usize);
        let mut reduce_uniforms = Vec::with_capacity(mip_level_count.saturating_sub(1) as usize);
        for level in 1..mip_level_count {
            let uniforms = ReduceUniforms {
                source_size: [
                    mip_dimension(width, level - 1),
                    mip_dimension(height, level - 1),
                ],
                target_size: [mip_dimension(width, level), mip_dimension(height, level)],
            };
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep Engine native Hi-Z reduce uniforms"),
                contents: bytemuck::bytes_of(&uniforms),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            reduce_bind_groups.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Deep Engine native Hi-Z reduce bindings"),
                layout: &reduce_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            &level_views[(level - 1) as usize],
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&level_views[level as usize]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: buffer.as_entire_binding(),
                    },
                ],
            }));
            reduce_uniforms.push(buffer);
        }

        Self::fill_far_plane(queue, &texture, width, height, mip_level_count);

        Ok(Self {
            texture,
            chain_view,
            level_views,
            extract_bind_group,
            extract_pipeline,
            reduce_bind_groups,
            reduce_uniforms,
            anchored_pipeline,
            variable_pipeline,
            width,
            height,
            mip_level_count,
        })
    }

    /// 全链远平面填充(创建/重建时一次):行距按 256B 对齐的暂存上传。
    /// 第一帧遮挡判定 dispatch(帧首)在本帧提取 pass 之前执行,若金字塔
    /// 仍是 wgpu 零初始化(0.0 = 最近),会把非零深度实例全部误剔
    /// (真实窗口冒烟实测 visible=1/3)。
    fn fill_far_plane(
        queue: &wgpu::Queue,
        texture: &wgpu::Texture,
        width: u32,
        height: u32,
        mip_level_count: u32,
    ) {
        for level in 0..mip_level_count {
            let w = mip_dimension(width, level);
            let h = mip_dimension(height, level);
            let bytes_per_row = (w * 4).next_multiple_of(256);
            let mut data = vec![0u8; (bytes_per_row * h) as usize];
            let texel = 1.0f32.to_le_bytes();
            for row in 0..h {
                let start = (row * bytes_per_row) as usize;
                for texel_index in 0..w {
                    let offset = start + texel_index as usize * 4;
                    data[offset..offset + 4].copy_from_slice(&texel);
                }
            }
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture,
                    mip_level: level,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
            );
        }
    }

    /// 第 0 层尺寸与层数(证据/日志口径)。
    #[cfg(test)]
    pub(crate) fn dims(&self) -> (u32, u32, u32) {
        (self.width, self.height, self.mip_level_count)
    }

    /// 顶层 = 逐实例 mip 定档上限(内核在 [0, top] 内按足迹选层)。
    /// 视图必须是全 mip 链视图:判定内核 `textureLoad(hiz, coord, level)`
    /// 按「视图内绝对层号」读,单层视图会越界读 0(WGSL 越界回 0)→
    /// 全部误剔;这与受控合成金字塔测试的默认全链视图一致。
    pub(crate) fn occlusion_source(&self) -> OcclusionSource {
        OcclusionSource {
            view: self.chain_view.clone(),
            width: self.width,
            height: self.height,
            mip_level: self.mip_level_count - 1,
        }
    }

    /// 全帧编码:提取(opaque 深度 → mip 0)+ 逐级缩减。由 frame.rs 在
    /// opaque 段之后调用一次。
    pub(crate) fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        self.encode_extract(encoder);
        self.encode_reduce(encoder);
    }

    fn encode_extract(&self, encoder: &mut wgpu::CommandEncoder) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native Hi-Z depth extract"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.level_views[0],
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    // 清屏 = 远平面(r32float 颜色载入 1.0):遮挡判定的保守
                    // 起点(首帧无历史深度)。
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 1.0,
                        g: 1.0,
                        b: 1.0,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            ..Default::default()
        });
        pass.set_pipeline(&self.extract_pipeline);
        pass.set_bind_group(0, &self.extract_bind_group, &[]);
        pass.draw(0..3, 0..1);
    }

    /// 缩减链单独编码(公开给测试:合成上传第 0 层后只跑缩减路径;
    /// 生产路径经 [`Self::encode`] 串联提取 + 缩减)。
    pub(crate) fn encode_reduce(&self, encoder: &mut wgpu::CommandEncoder) {
        for level in 1..self.mip_level_count {
            let source_width = mip_dimension(self.width, level - 1);
            let source_height = mip_dimension(self.height, level - 1);
            let pipeline = if reduce_is_anchored(source_width, source_height) {
                &self.anchored_pipeline
            } else {
                &self.variable_pipeline
            };
            let target_width = mip_dimension(self.width, level);
            let target_height = mip_dimension(self.height, level);
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Deep Engine native Hi-Z reduce"),
                ..Default::default()
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &self.reduce_bind_groups[(level - 1) as usize], &[]);
            pass.dispatch_workgroups(
                target_width.div_ceil(HI_Z_WORKGROUP_SIZE),
                target_height.div_ceil(HI_Z_WORKGROUP_SIZE),
                1,
            );
        }
    }

    /// 测试专用:上传第 0 层 r32float 数据(行距按 256B 对齐)。
    #[cfg(test)]
    pub(crate) fn seed_level0(&self, queue: &wgpu::Queue, data: &[f32]) {
        let bytes_per_row = (self.width * 4).next_multiple_of(256);
        let mut padded = vec![0u8; (bytes_per_row * self.height) as usize];
        for row in 0..self.height {
            let start = (row * bytes_per_row) as usize;
            let row_bytes = bytemuck::cast_slice(&data[(row * self.width) as usize..]);
            padded[start..start + row_bytes.len()].copy_from_slice(row_bytes);
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &padded,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
    }

    /// 读回某层(测试/证据专用):COPY_DST 布局按 256B 行对齐。
    #[cfg(test)]
    pub(crate) fn readback_level(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        level: u32,
    ) -> Vec<f32> {
        let width = mip_dimension(self.width, level);
        let height = mip_dimension(self.height, level);
        let bytes_per_row = (width * 4).next_multiple_of(256);
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Deep Engine native Hi-Z readback"),
            size: u64::from(bytes_per_row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Deep Engine native Hi-Z readback encoder"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: level,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: None,
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit(Some(encoder.finish()));
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        buffer.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = sender.send(result);
        });
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        receiver.recv().unwrap().unwrap();
        let mapped = buffer.get_mapped_range(..).unwrap();
        let mut values = Vec::with_capacity((width * height) as usize);
        for row in 0..height {
            let start = (row * bytes_per_row) as usize;
            for chunk in mapped[start..start + (width * 4) as usize].chunks_exact(4) {
                values.push(f32::from_le_bytes(chunk.try_into().unwrap()));
            }
        }
        drop(mapped);
        buffer.unmap();
        values
    }
}
