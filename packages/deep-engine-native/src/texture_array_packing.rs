//! 波次5 bindless 级 2:纹理数组打包索引合同的 Rust 镜像(identityGolden 模式)。
//!
//! 与 TS `packages/deep-engine/src/webgpu/textureArrayPacking.ts::planTextureArrays`
//! 逐语义对齐(同一索引合同双端一致,Rust 侧漂移由
//! `texture_array_packing_tests::matches_ts_golden_fixture` 对拍 fixture 抓住):
//! - 输入纹理按(格式×宽×高)分箱,箱键语义同 TS 的 `format|WxH`;
//! - 箱按(格式字典序, 宽, 高)排序后依次分配 arrayIndex(= 在 arrays 中的位置);
//! - 箱内按 textureId 字典序分配 layerIndex;
//! - 层数超过 `max_array_layers` 时仅前 N 层入数组,其余进 `overflowed`,由调用方
//!   回退常规 bind group 路径——fail-closed,绝不静默丢弃;
//! - 同名 textureId 跨箱重复时,后处理的箱(数组序更大)覆盖先前分配
//!   (与 TS `assignments.set` 的覆盖语义一致);
//! - 非法输入(空 id/format、零尺寸、maxArrayLayers < 1)一律 `Err`,不 panic、
//!   不钳制、不产出部分计划(与 TS 抛 RangeError/TypeError 同序)。
//!
//! 排序口径说明:wgpu 纹理格式名与仓内 textureId 均为 ASCII,字节序比较与 TS 的
//! `localeCompare` / `<` 在该域内结果一致;非 ASCII 输入不在本合同域内。
//! TS 侧的 `Number.isSafeInteger` 校验在 Rust 由 `u32` 类型本身承担(非负整数,
//! 上界对齐 wgpu 纹理维度上限)。

use std::collections::BTreeMap;
use std::fmt;

/// 计划输入的单条纹理(TS `TextureArrayPackingEntry`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextureArrayPackingEntry {
    pub texture_id: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
}

/// 计划输出的单个 texture_2d_array(TS `TextureArrayPlanEntry`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextureArrayPlanEntry {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub array_index: usize,
    pub layers: Vec<String>,
}

/// 纹理在数组中的分配(TS `assignments` 的值)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextureArrayAssignment {
    pub array_index: usize,
    pub layer_index: u32,
}

/// 打包计划(TS `TextureArrayPlan`)。
/// `assignments` 用 BTreeMap 承载 TS Map 的 id→分配 合同;查询语义一致,
/// 迭代序确定(按 id 字典序),便于跨端对拍。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextureArrayPlan {
    pub arrays: Vec<TextureArrayPlanEntry>,
    pub assignments: BTreeMap<String, TextureArrayAssignment>,
    pub overflowed: Vec<String>,
}

/// fail-closed 输入校验错误(TS 的 RangeError/TypeError 镜像)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextureArrayPackingError {
    /// TS: `RangeError("maxArrayLayers must be a positive safe integer.")`
    InvalidMaxArrayLayers,
    /// TS: `TypeError("Texture array entries require non-empty textureId and format.")`
    EmptyEntryIdentity,
    /// TS: `RangeError("Texture ${textureId} has invalid dimensions.")`
    InvalidDimensions { texture_id: String },
}

impl fmt::Display for TextureArrayPackingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMaxArrayLayers => {
                write!(formatter, "maxArrayLayers must be a positive safe integer.")
            }
            Self::EmptyEntryIdentity => write!(
                formatter,
                "Texture array entries require non-empty textureId and format."
            ),
            Self::InvalidDimensions { texture_id } => {
                write!(formatter, "Texture {texture_id} has invalid dimensions.")
            }
        }
    }
}

impl std::error::Error for TextureArrayPackingError {}

/// 与 TS `planTextureArrays` 逐语义对齐的打包函数(见模块文档的合同清单)。
pub fn plan_texture_arrays(
    entries: &[TextureArrayPackingEntry],
    max_array_layers: u32,
) -> Result<TextureArrayPlan, TextureArrayPackingError> {
    if max_array_layers < 1 {
        return Err(TextureArrayPackingError::InvalidMaxArrayLayers);
    }
    // 分箱:BTreeMap 键 (format, width, height) 的迭代序即 TS sortedBoxes 的
    // (格式字典序, 宽, 高) 排序;校验按输入顺序逐条进行,与 TS 同序失败。
    let mut boxes: BTreeMap<(String, u32, u32), Vec<String>> = BTreeMap::new();
    for entry in entries {
        if entry.texture_id.is_empty() || entry.format.is_empty() {
            return Err(TextureArrayPackingError::EmptyEntryIdentity);
        }
        if entry.width == 0 || entry.height == 0 {
            return Err(TextureArrayPackingError::InvalidDimensions {
                texture_id: entry.texture_id.clone(),
            });
        }
        boxes
            .entry((entry.format.clone(), entry.width, entry.height))
            .or_default()
            .push(entry.texture_id.clone());
    }
    let mut plan = TextureArrayPlan::default();
    let max_layers = max_array_layers as usize;
    for ((format, width, height), mut ids) in boxes {
        let array_index = plan.arrays.len();
        // 箱内字典序(TS `a < b ? -1 : 1`);重复 id 的相对序不可观测(串相同)。
        ids.sort_unstable();
        let fitted = ids.len().min(max_layers);
        for (layer_index, texture_id) in ids[..fitted].iter().enumerate() {
            plan.assignments.insert(
                texture_id.clone(),
                TextureArrayAssignment {
                    array_index,
                    layer_index: layer_index as u32,
                },
            );
        }
        plan.overflowed.extend(ids[fitted..].iter().cloned());
        plan.arrays.push(TextureArrayPlanEntry {
            format,
            width,
            height,
            array_index,
            layers: ids[..fitted].to_vec(),
        });
    }
    Ok(plan)
}

#[cfg(test)]
#[path = "texture_array_packing_tests.rs"]
mod tests;
