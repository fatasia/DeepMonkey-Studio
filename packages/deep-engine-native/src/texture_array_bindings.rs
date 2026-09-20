//! 波次5 bindless 级 2:Native wgpu 纹理数组绑定合同(对齐 Web
//! `webgpu/textureArrayResources.ts` 的资源结构,同一索引合同双端一致)。
//! 本波次只立合同与对拍,不接线;索引分配的唯一来源是
//! `deep_engine_native::texture_array_packing`(identityGolden 已与 TS 对拍)。
//!
//! ## 渲染器接线合同(本波次不执行,接线点只记录在此)
//! - 布局替代点:`renderer.rs::create_material_layout`(D2 逐材质)→
//!   [`create_texture_array_material_layout`];renderer.rs 的既有渲染路径保持只读不动。
//! - 材质侧:`gpu_textures.rs::GpuMaterial` 的 bind group(view/sampler/uniform)→
//!   增补 binding 11 的 [`MaterialArrayIndices`] uniform(32B);`PreparedMaterial`
//!   的纹理解析改走 packing 的 (arrayIndex, layerIndex);任一在用槽位溢出/缺分配 →
//!   整材质回退既有 D2 路径并计数,绝不部分数组化(Web materialGroup 同语义)。
//! - WGSL 侧需配套 `texture_2d_array` 采样声明与索引 uniform 读取(对齐 Web
//!   textureArrayWgsl 双轨开关);本波次不改任何 WGSL。
//! - fail-closed 纪律:接线时先 [`validate_plan_against_device`](构造期一致性与设备
//!   上限),再建资源;未知/压缩格式经 [`parse_texture_format_name`] 返回 None 即拒绝
//!   入数组(级 1/2 合同:压缩层显式拒绝)。

// 合同函数先于接线落地:本波次不改 renderer.rs 的既有渲染路径(接线点见模块文档),
// 未被调用的合同函数是预期状态;接线时随首个调用点移除本 allow。
#![allow(dead_code)]

use bytemuck::{Pod, Zeroable};
use deep_engine_native::mesh_abi::MATERIAL_UNIFORM_BYTES;
use deep_engine_native::texture_array_packing::{TextureArrayPlan, TextureArrayPlanEntry};
use wgpu::util::DeviceExt;

/// 槽位语义:baseColor, metallicRoughness, occlusion, normal, emissive(Web 同序)。
pub const MATERIAL_ARRAY_SLOT_COUNT: usize = 5;
/// MaterialArrayIndices = layerRow(vec4i) + emissiveLayerRow(vec4i)(Web 同布局)。
pub const MATERIAL_ARRAY_INDEX_FLOATS: usize = 8;
pub const MATERIAL_ARRAY_INDICES_BYTES: u64 =
    (MATERIAL_ARRAY_INDEX_FLOATS * std::mem::size_of::<i32>()) as u64;

/// 槽位→绑定号静态合同:0..4 数组纹理视图、5..9 采样器;indexOffset 是 32B 通道内偏移
/// (Web TEXTURE_ARRAY_SLOT_BINDINGS 逐位一致)。材质参数 uniform 仍是 160B 块。
pub const TEXTURE_ARRAY_SLOT_MAP_BINDINGS: [u32; MATERIAL_ARRAY_SLOT_COUNT] = [0, 1, 2, 3, 4];
pub const TEXTURE_ARRAY_SLOT_SAMPLER_BINDINGS: [u32; MATERIAL_ARRAY_SLOT_COUNT] = [5, 6, 7, 8, 9];
pub const TEXTURE_ARRAY_SLOT_INDEX_OFFSETS: [usize; MATERIAL_ARRAY_SLOT_COUNT] = [0, 1, 2, 3, 4];
pub const MATERIAL_UNIFORM_BINDING: u32 = 10;
pub const ARRAY_INDICES_BINDING: u32 = 11;

/// 32B 数组索引通道:8×i32,槽位层号写在 [`TEXTURE_ARRAY_SLOT_INDEX_OFFSETS`],
/// 未分配槽位写 0(Web `assignment?.layerIndex ?? 0`),配合 dummy 视图采样无效值。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
#[repr(C)]
pub struct MaterialArrayIndices(pub [i32; MATERIAL_ARRAY_INDEX_FLOATS]);

impl MaterialArrayIndices {
    /// 槽位层号 → 通道值(Web materialGroup 的 indices 组装同语义)。
    pub fn from_slot_layers(layers: [Option<u32>; MATERIAL_ARRAY_SLOT_COUNT]) -> Self {
        let mut indices = [0i32; MATERIAL_ARRAY_INDEX_FLOATS];
        for (slot, layer) in layers.into_iter().enumerate() {
            indices[TEXTURE_ARRAY_SLOT_INDEX_OFFSETS[slot]] = layer.unwrap_or(0) as i32;
        }
        Self(indices)
    }

    pub fn as_bytes(&self) -> &[u8] {
        bytemuck::bytes_of(self)
    }
}

/// 计划一致性 + 设备上限合同(Web `validatePlan` 镜像,检查同序):
/// arrayIndex 必须等于位置、层数不超设备 maxTextureArrayLayers、分配必须落在
/// 对应数组的对应层、溢出纹理不得残留分配。任何违例 `Err`,绝不静默钳制。
pub fn validate_plan_against_device(
    plan: &TextureArrayPlan,
    max_texture_array_layers: u32,
) -> Result<(), String> {
    if max_texture_array_layers < 1 {
        return Err("Device maxTextureArrayLayers is unavailable.".into());
    }
    for (position, array) in plan.arrays.iter().enumerate() {
        if array.array_index != position {
            return Err(format!(
                "Texture array index diverged from position: {}.",
                array.array_index
            ));
        }
        if array.layers.len() > max_texture_array_layers as usize {
            return Err(format!(
                "Texture array {position} exceeds device maxTextureArrayLayers ({} > {max_texture_array_layers}).",
                array.layers.len()
            ));
        }
    }
    for (texture_id, assignment) in &plan.assignments {
        let in_bounds = plan
            .arrays
            .get(assignment.array_index)
            .and_then(|array| array.layers.get(assignment.layer_index as usize))
            .is_some_and(|layer| layer == texture_id);
        if !in_bounds {
            return Err(format!(
                "Texture array assignment is out of bounds: {texture_id}."
            ));
        }
    }
    for texture_id in &plan.overflowed {
        if plan.assignments.contains_key(texture_id) {
            return Err(format!(
                "Overflowed texture must not keep an array assignment: {texture_id}."
            ));
        }
    }
    Ok(())
}

/// 解析 wgpu 未压缩格式名(数组可入集);压缩/未知格式返回 `None`,调用方必须
/// fail-closed 拒绝入数组。wgpu 30 未提供 TextureFormat::from_str,此表是合同面。
pub fn parse_texture_format_name(name: &str) -> Option<wgpu::TextureFormat> {
    Some(match name {
        "r8unorm" => wgpu::TextureFormat::R8Unorm,
        "r8snorm" => wgpu::TextureFormat::R8Snorm,
        "r8uint" => wgpu::TextureFormat::R8Uint,
        "r8sint" => wgpu::TextureFormat::R8Sint,
        "r16uint" => wgpu::TextureFormat::R16Uint,
        "r16sint" => wgpu::TextureFormat::R16Sint,
        "r16float" => wgpu::TextureFormat::R16Float,
        "r32uint" => wgpu::TextureFormat::R32Uint,
        "r32sint" => wgpu::TextureFormat::R32Sint,
        "r32float" => wgpu::TextureFormat::R32Float,
        "rg8unorm" => wgpu::TextureFormat::Rg8Unorm,
        "rg8snorm" => wgpu::TextureFormat::Rg8Snorm,
        "rg8uint" => wgpu::TextureFormat::Rg8Uint,
        "rg8sint" => wgpu::TextureFormat::Rg8Sint,
        "rg16uint" => wgpu::TextureFormat::Rg16Uint,
        "rg16sint" => wgpu::TextureFormat::Rg16Sint,
        "rg16float" => wgpu::TextureFormat::Rg16Float,
        "rg32uint" => wgpu::TextureFormat::Rg32Uint,
        "rg32sint" => wgpu::TextureFormat::Rg32Sint,
        "rg32float" => wgpu::TextureFormat::Rg32Float,
        "rgba8unorm" => wgpu::TextureFormat::Rgba8Unorm,
        "rgba8unorm-srgb" => wgpu::TextureFormat::Rgba8UnormSrgb,
        "rgba8snorm" => wgpu::TextureFormat::Rgba8Snorm,
        "rgba8uint" => wgpu::TextureFormat::Rgba8Uint,
        "rgba8sint" => wgpu::TextureFormat::Rgba8Sint,
        "rgba16uint" => wgpu::TextureFormat::Rgba16Uint,
        "rgba16sint" => wgpu::TextureFormat::Rgba16Sint,
        "rgba16float" => wgpu::TextureFormat::Rgba16Float,
        "rgba32uint" => wgpu::TextureFormat::Rgba32Uint,
        "rgba32sint" => wgpu::TextureFormat::Rgba32Sint,
        "rgba32float" => wgpu::TextureFormat::Rgba32Float,
        "bgra8unorm" => wgpu::TextureFormat::Bgra8Unorm,
        "bgra8unorm-srgb" => wgpu::TextureFormat::Bgra8UnormSrgb,
        _ => return None,
    })
}

/// 计划数组 → texture_2d_array 纹理(Web stageArray 的描述符合同)。
/// 层内容上传与 mip/采样器一致性检查归宿主(Web 同分工),本函数守描述符合法性:
/// 未知/压缩格式与空层数组 fail-closed 拒绝。usage 合同为 TEXTURE_BINDING | COPY_DST。
pub fn create_array_texture(
    device: &wgpu::Device,
    array: &TextureArrayPlanEntry,
    mip_level_count: u32,
    usage: wgpu::TextureUsages,
) -> Result<wgpu::Texture, String> {
    let format = parse_texture_format_name(&array.format).ok_or_else(|| {
        format!(
            "texture array {} uses a format not admitted into arrays: {}",
            array.array_index, array.format
        )
    })?;
    if array.layers.is_empty() {
        return Err(format!(
            "texture array {} has no layers.",
            array.array_index
        ));
    }
    let label = format!("Deep texture array {}", array.array_index);
    Ok(device.create_texture(&wgpu::TextureDescriptor {
        label: Some(&label),
        size: wgpu::Extent3d {
            width: array.width,
            height: array.height,
            depth_or_array_layers: array.layers.len() as u32,
        },
        mip_level_count,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    }))
}

/// 数组视图合同:材质绑定必须用 D2Array 视图(Web `createView({dimension:"2d-array"})`)。
pub fn create_texture_array_view(texture: &wgpu::Texture) -> wgpu::TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    })
}

/// 未分配槽位的 dummy 资源合同:1×1×1 rgba8unorm(Web dummyView 同构),
/// 让 binding 0..4 恒可满足,采样结果无效但绝不缺绑定。
pub fn create_dummy_array_texture(device: &wgpu::Device) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep texture array dummy"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

/// 数组版材质 bind group layout:binding 0..4 D2Array float 纹理、5..9 filtering
/// 采样器、10 材质参数 uniform(160B,minBindingSize 与既有 D2 路径同 ABI)、
/// 11 数组索引 uniform(32B)。fragment-only,与 Web materialLayout 逐项一致。
pub fn create_texture_array_material_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    let texture = |binding: u32| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2Array,
            multisampled: false,
        },
        count: None,
    };
    let sampler = |binding: u32| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    };
    let uniform = |binding: u32, min_binding_size: u64| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(min_binding_size),
        },
        count: None,
    };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native texture array material layout v1"),
        entries: &[
            texture(0),
            texture(1),
            texture(2),
            texture(3),
            texture(4),
            sampler(5),
            sampler(6),
            sampler(7),
            sampler(8),
            sampler(9),
            uniform(MATERIAL_UNIFORM_BINDING, MATERIAL_UNIFORM_BYTES),
            uniform(ARRAY_INDICES_BINDING, MATERIAL_ARRAY_INDICES_BYTES),
        ],
    })
}

/// 32B 索引通道 buffer(UNIFORM | COPY_DST,COPY_DST 供既有读回验证路径复用)。
pub fn create_material_array_indices_buffer(
    device: &wgpu::Device,
    indices: &MaterialArrayIndices,
) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Deep Engine native material array indices v1"),
        contents: indices.as_bytes(),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    })
}

/// 索引通道原位更新合同(Queue::write_buffer,与 write_material_uniforms 同机制)。
pub fn write_material_array_indices(
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    indices: &MaterialArrayIndices,
) {
    queue.write_buffer(buffer, 0, indices.as_bytes());
}

#[cfg(test)]
#[path = "texture_array_bindings_tests.rs"]
mod tests;
