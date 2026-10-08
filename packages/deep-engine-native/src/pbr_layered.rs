//! I-C23 分层材质 Native 侧 · 304B 层块打包与求值响应级混合 CPU 参考。
//!
//! 与 Web 单源对齐:
//! - 304B 块布局 = TS `packLayeredSurfaceBlock` 逐字节镜像(header 16B + 2×144B 行,
//!   每行 9×vec4:params0/params1/colorCoverage/surfaceMode/baseRow0/baseRow1/
//!   mrRow0/mrRow1/indices)。既有 192B Web 材质块、224B 数组行、native 基础块
//!   (C9 后 240B:核心 40 float 逐字节不变+扩展/advanced 带)不动。
//! - 混合闭式 = `wgsl/materialLayerBlend.wgsl`(唯一真源)与 TS
//!   `materialLayeredEvaluate.blendChannel` 逐运算镜像:两种模式同为凸混合,权重 w
//!   只由层总响应 rgb 派生并共享给全部通道(replace w=coverage;overlay w=coverage×
//!   clamp01(layer))。凸性 ⇒ 输出 ≤ max(双亲),白炉口径 ≤1 由双亲直接继承。
//!
//! Native 活动层清漆复用 T08 共享核,只替换主方向光;IBL/GI/局部灯/自发光
//! 保持 stock 响应。层 IOR 经介电 F0 消费,304B params0.y/z 消费清漆因子与
//! 粗糙度。基材清漆及各向异性/透射由发布合同拒绝。factor0 原样返回 stock;
//! 原白炉 fixture 的扩展词全零,双端旧响应逐位保持。

use crate::contract::{LayerBlendMode, LayerResponseModel, MaterialLayer, PbrMaterial, TextureSlot};

/// 304B 层块(header 16B + 2×144B 行,16B 对齐 uniform)。
pub const LAYERED_SURFACE_BLOCK_BYTES: usize = 304;
pub const LAYERED_SURFACE_BLOCK_FLOATS: usize = LAYERED_SURFACE_BLOCK_BYTES / 4;
/// 单层行 144B = 36 f32 = 9×vec4。
pub const LAYERED_SURFACE_ROW_BYTES: usize = 144;
pub const LAYERED_SURFACE_ROW_FLOATS: usize = LAYERED_SURFACE_ROW_BYTES / 4;
/// 块 ABI 版本(word1;与 TS LAYERED_SURFACE_ABI_VERSION 互钉)。
pub const LAYERED_SURFACE_ABI_VERSION: u32 = 1;
/// 层栈深度上限(与 MATERIAL_LAYER_MAX_COUNT / DEEP_LAYER_MAX_COUNT 互钉)。
pub const LAYERED_MAX_COUNT: usize = 2;
/// 分层能力请求的片段采样纹理上限(与 Web LAYERED_MATERIAL_REQUIRED_TEXTURES 互钉;
/// native 实际占 13,常量保持 Web 合同值,capability 检查用它)。
pub const LAYERED_MATERIAL_REQUIRED_TEXTURES: u32 = 19;

/// 单行纹理绑定:仿射 UV 变换两行 + UV set + 纹理数组层(native 恒 0)。
#[derive(Clone, Debug, PartialEq)]
pub struct LayerTextureBinding {
    pub uv_transform: [f32; 6],
    pub tex_coord: u8,
    pub array_layer: u32,
}

/// 一条活动层的 304B 行输入(TS `LayeredSurfaceParameters` 行 + 绑定槽的打包形态)。
#[derive(Clone, Debug, PartialEq)]
pub struct LayeredBlockRow {
    /// 层扩展参数 [ior, clearcoatFactor, clearcoatRoughness,
    /// anisotropyStrength, anisotropyRotation, transmissionFactor]。
    pub params: [f32; 6],
    pub coverage: f32,
    pub overlay: bool,
    pub metal_reflection: bool,
    pub color: Option<[f32; 3]>,
    pub metallic: Option<f32>,
    pub roughness: Option<f32>,
    pub base_color_texture: Option<LayerTextureBinding>,
    pub metallic_roughness_texture: Option<LayerTextureBinding>,
}

impl LayeredBlockRow {
    /// surfaceMode.w 的覆盖旗标(bit0 颜色 / bit1 金属 / bit2 粗糙;与 Web 同位)。
    /// 旗标以**整数值**存为 f32(TS `Number(a) | (Number(b) << 1) | ...`),非 from_bits。
    fn flags(&self) -> f32 {
        (u32::from(self.color.is_some())
            | (u32::from(self.metallic.is_some()) << 1)
            | (u32::from(self.roughness.is_some()) << 2)
            | (u32::from(self.metal_reflection) << 3)) as f32
    }
}

/// 层扩展参数的缺省值(TS DEFAULT_EXTENDED_MATERIAL_PARAMETERS 家族镜像)。
pub const DEFAULT_LAYER_PARAMS: [f32; 6] = [1.5, 0.0, 0.0, 0.0, 0.0, 0.0];

/// 打包 304B 块;`rows` 只携带**活动**(coverage>0)层,顺序 = 应用序。
/// 输出与 TS `packLayeredSurfaceBlock` 逐字节一致(含 -0 归一)。
pub fn pack_layered_surface_block(rows: &[LayeredBlockRow]) -> [f32; LAYERED_SURFACE_BLOCK_FLOATS] {
    let mut block = [0.0f32; LAYERED_SURFACE_BLOCK_FLOATS];
    for (active, row) in rows.iter().enumerate() {
        let base = 4 + active * LAYERED_SURFACE_ROW_FLOATS;
        block[base..base + 6].copy_from_slice(&row.params);
        let color = row.color.unwrap_or([1.0, 1.0, 1.0]);
        block[base + 8] = color[0];
        block[base + 9] = color[1];
        block[base + 10] = color[2];
        block[base + 11] = row.coverage;
        block[base + 12] = row.metallic.unwrap_or(0.0);
        block[base + 13] = row.roughness.unwrap_or(0.0);
        block[base + 14] = f32::from(row.overlay);
        block[base + 15] = row.flags();
        for (binding, offset, code_offset) in [
            (&row.base_color_texture, 16usize, 32usize),
            (&row.metallic_roughness_texture, 24usize, 33usize),
        ] {
            // TS 语义:变换词恒写(无纹理时单位变换),selector 0 表达"无纹理";
            // 数组层码恒写(无纹理 0)。
            let (transform, selector, array_layer) = match binding {
                Some(binding) => (
                    binding.uv_transform,
                    f32::from(binding.tex_coord) + 1.0,
                    binding.array_layer,
                ),
                None => ([1.0, 0.0, 0.0, 0.0, 1.0, 0.0], 0.0, 0),
            };
            block[base + offset] = transform[0];
            block[base + offset + 1] = transform[1];
            block[base + offset + 2] = transform[2];
            block[base + offset + 3] = selector;
            block[base + offset + 4] = transform[3];
            block[base + offset + 5] = transform[4];
            block[base + offset + 6] = transform[5];
            block[base + offset + 7] = 0.0;
            let index = base + code_offset;
            block[index] = f32::from_bits(array_layer);
        }
    }
    let active_count = rows.len() as u32;
    block[0] = f32::from_bits(active_count);
    block[1] = f32::from_bits(LAYERED_SURFACE_ABI_VERSION);
    block
}

/// 合同层 → 打包行。coverage=0 的层按合同剪除(零覆盖层不产生任何求值扰动)。
/// 层参数缺省 = DEFAULT_LAYER_PARAMS;纹理变换由调用方按 prepare 合同预计算
/// (与基材 `write_transform_parts` 同式),此处只做 UV set 域兜底校验。
pub fn layered_block_rows(
    material: &PbrMaterial,
    transform_of: impl Fn(&TextureSlot) -> Result<LayerTextureBinding, String>,
) -> Result<Vec<LayeredBlockRow>, String> {
    let Some(layered) = &material.layered else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for layer in &layered.layers {
        let coverage = layer.coverage.unwrap_or(0.0);
        if coverage == 0.0 {
            continue;
        }
        rows.push(LayeredBlockRow {
            params: layer_params(layer),
            coverage,
            overlay: layer.mode == Some(LayerBlendMode::Overlay),
            metal_reflection: layer.response_model == Some(LayerResponseModel::MicrofacetMetalReflection),
            color: layer.surface.as_ref().and_then(|s| s.base_color),
            metallic: layer.surface.as_ref().and_then(|s| s.metallic),
            roughness: layer.surface.as_ref().and_then(|s| s.roughness),
            base_color_texture: layer
                .surface
                .as_ref()
                .and_then(|s| s.base_color_texture.as_ref())
                .map(&transform_of)
                .transpose()?,
            metallic_roughness_texture: layer
                .surface
                .as_ref()
                .and_then(|s| s.metallic_roughness_texture.as_ref())
                .map(&transform_of)
                .transpose()?,
        });
    }
    Ok(rows)
}

/// 层参数 → 6 f32(缺省合并);IOR 与清漆由 shader 消费,其余瓣由发布合同拒绝。
fn layer_params(layer: &MaterialLayer) -> [f32; 6] {
    let Some(params) = &layer.params else {
        return DEFAULT_LAYER_PARAMS;
    };
    let rotation = params.anisotropy.as_ref().and_then(|a| a.rotation).unwrap_or(0.0);
    let rotation = if layer.response_model == Some(LayerResponseModel::MicrofacetMetalReflection) {
        if rotation == -std::f32::consts::PI { std::f32::consts::PI } else { rotation }
    } else { rotation };
    [
        params.ior.unwrap_or(DEFAULT_LAYER_PARAMS[0]),
        params
            .clearcoat
            .as_ref()
            .and_then(|c| c.factor)
            .unwrap_or(0.0),
        params
            .clearcoat
            .as_ref()
            .and_then(|c| c.roughness)
            .unwrap_or(0.0),
        params
            .anisotropy
            .as_ref()
            .and_then(|a| a.strength)
            .unwrap_or(0.0),
        rotation,
        params
            .transmission
            .as_ref()
            .and_then(|t| t.factor)
            .unwrap_or(0.0),
    ]
}

/// 求值响应级凸混合闭式(逐通道;与 wgsl/materialLayerBlend.wgsl 及
/// materialLayeredEvaluate 逐运算镜像:先 w,后乘加)。overlay 权重逐通道
/// clamp01(layer),不是标量最大值 —— 权重向量与 TS layerWeights 同构。
pub fn blend_channel(underlying: f32, layer: f32, weight_layer: f32) -> f32 {
    (1.0 - weight_layer) * underlying + weight_layer * layer
}

pub fn blend_rgb(
    underlying: [f32; 3],
    layer: [f32; 3],
    coverage: f32,
    overlay: bool,
) -> [f32; 3] {
    let weights = if overlay {
        [
            coverage * layer[0].clamp(0.0, 1.0),
            coverage * layer[1].clamp(0.0, 1.0),
            coverage * layer[2].clamp(0.0, 1.0),
        ]
    } else {
        [coverage; 3]
    };
    [
        blend_channel(underlying[0], layer[0], weights[0]),
        blend_channel(underlying[1], layer[1], weights[1]),
        blend_channel(underlying[2], layer[2], weights[2]),
    ]
}

/// 层栈响应混合 CPU 参考(应用序 = 数组序;零覆盖层剪枝)。
pub fn blend_layer_stack(
    base: [f32; 3],
    layers: &[([f32; 3], LayerResponse)],
) -> [f32; 3] {
    let mut result = base;
    for (layer_rgb, response) in layers {
        if response.coverage == 0.0 {
            continue;
        }
        result = blend_rgb(result, *layer_rgb, response.coverage, response.overlay);
    }
    result
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerResponse {
    pub coverage: f32,
    pub overlay: bool,
}

/// 白炉凸性上界:两种模式都是凸混合(逐通道权重和恒 1),输出 ≤ max(双亲)。
/// 双亲各自满足白炉口径 ≤1 时,混合结果必然 ≤1 —— 分层白炉 ≤1 由构造保证,
/// 这是 GPU 白炉轮的先验预测,CPU 参考值供主线程对拍。
pub fn furnace_bound_holds(base: [f32; 3], layers: &[([f32; 3], LayerResponse)]) -> bool {
    let blended = blend_layer_stack(base, layers);
    let max_parent = base
        .into_iter()
        .chain(layers.iter().flat_map(|(rgb, _)| *rgb))
        .fold(0.0f32, f32::max);
    blended.into_iter().all(|channel| channel <= max_parent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{
        LayerAnisotropyParams, LayerClearcoatParams, LayerMaterialParams, LayerSurface,
        LayerTransmissionParams, LayeredMaterial,
    };

    fn slot(tex_coord: u8) -> TextureSlot {
        TextureSlot {
            texture: format!("t{tex_coord}"),
            tex_coord: Some(tex_coord),
            offset: None,
            scale: None,
            rotation: None,
        }
    }

    fn surface(
        color: Option<[f32; 3]>,
        base_slot: Option<TextureSlot>,
        mr_slot: Option<TextureSlot>,
    ) -> LayerSurface {
        LayerSurface {
            base_color: color,
            metallic: Some(0.25),
            roughness: Some(0.5),
            base_color_texture: base_slot,
            metallic_roughness_texture: mr_slot,
        }
    }

    fn params(ior: f32) -> LayerMaterialParams {
        LayerMaterialParams {
            ior: Some(ior),
            clearcoat: Some(LayerClearcoatParams {
                factor: Some(0.0),
                roughness: Some(0.0),
            }),
            anisotropy: Some(LayerAnisotropyParams {
                strength: Some(0.0),
                rotation: Some(0.0),
            }),
            transmission: Some(LayerTransmissionParams { factor: Some(0.0) }),
        }
    }

    fn layered_material() -> LayeredMaterial {
        LayeredMaterial {
            base: Some(params(1.5)),
            layers: vec![
                MaterialLayer {
                    response_model: None,
                    params: Some(params(1.5)),
                    coverage: Some(0.75),
                    mode: Some(LayerBlendMode::Overlay),
                    surface: Some(surface(
                        Some([0.8, 0.2, 0.1]),
                        Some(slot(1)),
                        Some(slot(0)),
                    )),
                },
                MaterialLayer {
                    response_model: None,
                    params: Some(params(1.5)),
                    coverage: Some(0.5),
                    mode: Some(LayerBlendMode::Replace),
                    surface: Some(surface(Some([0.1, 0.9, 0.4]), None, None)),
                },
            ],
        }
    }

    fn material_with_layers(layered: Option<LayeredMaterial>) -> PbrMaterial {
        PbrMaterial {
            id: "m".into(),
            shading_model: None,
            base_color: [0.1, 0.2, 0.3],
            metallic: 0.4,
            roughness: 0.6,
            ior: None,
            base_color_texture: None,
            metallic_roughness_texture: None,
            normal_texture: None,
            occlusion_texture: None,
            emissive_factor: None,
            emissive_texture: None,
            specular_factor: None, specular_color_factor: None,
            specular_texture: None, specular_color_texture: None,
            base_color_alpha: None,
            alpha_mode: None,
            alpha_cutoff: None,
            double_sided: None,
            premultiplied_alpha: None,
            fog: None,
            layered,
            extended_parameters: None,
            advanced_parameters: None,
        }
    }

    fn identity(tex_coord: u8) -> Result<LayerTextureBinding, String> {
        Ok(LayerTextureBinding {
            uv_transform: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            tex_coord,
            array_layer: 0,
        })
    }

    /// 零覆盖层剪枝与活动计数:coverage=0 的层不进块,后续层前移。
    #[test]
    fn zero_coverage_layers_are_pruned_from_block() {
        let mut material = layered_material();
        material.layers[0].coverage = Some(0.0);
        let rows = layered_block_rows(&material_with_layers(Some(material.clone())), |_| identity(0)).unwrap();
        assert_eq!(rows.len(), 1);
        let block = pack_layered_surface_block(&rows);
        assert_eq!(f32::to_bits(block[0]), 1);
        assert_eq!(f32::to_bits(block[1]), LAYERED_SURFACE_ABI_VERSION);
        // 剪除后的层占用槽 0,槽 1 保持全零。
        assert_eq!(block[4], 1.5);
        assert_eq!(block[4 + LAYERED_SURFACE_ROW_FLOATS..][..4], [0.0; 4]);
    }

    /// 304B 行布局逐字检查:参数、颜色覆盖率、模式旗标、UV 变换与数组层码。
    #[test]
    fn block_row_layout_matches_web_abi() {
        let material = layered_material();
        let rows = layered_block_rows(&material_with_layers(Some(material.clone())), |slot| {
            Ok(LayerTextureBinding {
                uv_transform: [1.0, 0.0, 0.25, 0.0, 1.0, 0.0],
                tex_coord: slot.tex_coord.unwrap_or(0),
                array_layer: 0,
            })
        })
        .unwrap();
        assert_eq!(rows.len(), 2);
        let block = pack_layered_surface_block(&rows);
        assert_eq!(f32::to_bits(block[0]), 2);
        // 行 0:params(base+0..6)、colorCoverage(base+8..12)、surfaceMode(base+12..16)。
        assert_eq!(&block[4..10], &[1.5, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(&block[12..16], &[0.8, 0.2, 0.1, 0.75]);
        assert_eq!(&block[16..20], &[0.25, 0.5, 1.0, 7.0]); // overlay=1,flags=1|2|4
        // baseColor 纹理行(base+16..24):[1,0,0.25,uv+1=2, 0,1,0,0];数组层码在 base+32。
        assert_eq!(&block[20..28], &[1.0, 0.0, 0.25, 2.0, 0.0, 1.0, 0.0, 0.0]);
        assert_eq!(f32::to_bits(block[36]), 0);
        // MR 纹理行(base+24..32):[1,0,0,uv+1=1, 0,1,0,0];数组层码在 base+33。
        assert_eq!(&block[28..36], &[1.0, 0.0, 0.25, 1.0, 0.0, 1.0, 0.0, 0.0]);
        assert_eq!(f32::to_bits(block[37]), 0);
        // 行 1:replace、无纹理槽,selector 恒 0。
        let base1 = 4 + LAYERED_SURFACE_ROW_FLOATS;
        assert_eq!(&block[base1 + 12..base1 + 16], &[0.25, 0.5, 0.0, 7.0]);
        assert_eq!(block[base1 + 16..base1 + 24], [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    }

    /// 纹理槽 UV set 域兜底(>1 在 validate 已拦,此处防御 prepare 误用)。
    #[test]
    fn invalid_uv_transform_is_rejected() {
        let material = layered_material();
        let rows = layered_block_rows(&material_with_layers(Some(material.clone())), |_| {
            Err("invalid texture transform".into())
        });
        assert!(rows.is_err());
    }

    /// 凸混合闭式与 WGSL/TS 镜像逐运算一致(replace w=coverage)。
    #[test]
    fn replace_blend_is_convex_coverage() {
        let blended = blend_rgb([1.0, 0.5, 0.0], [0.0, 0.25, 1.0], 0.75, false);
        assert_eq!(blended, [0.25, 0.3125, 0.75]);
    }

    /// overlay 权重 = coverage×clamp01(layer) 逐通道;层响应弱则底材全保留。
    #[test]
    fn overlay_blend_self_masks_by_layer_response() {
        let weak = blend_rgb([1.0, 1.0, 1.0], [0.02, 0.0, 0.5], 1.0, true);
        assert_eq!(weak, [0.9804, 1.0, 0.75]);
        let saturated = blend_rgb([1.0, 0.5, 0.0], [2.0, 1.0, 4.0], 0.5, true);
        // 层响应饱和(L≥1)逐通道收敛于 replace(w=coverage)。
        assert_eq!(saturated, blend_rgb([1.0, 0.5, 0.0], [2.0, 1.0, 4.0], 0.5, false));
        // 权重是逐通道的:混合通道权重不同。
        let mixed = blend_rgb([1.0, 1.0, 1.0], [0.5, 0.0, 1.0], 1.0, true);
        assert_eq!(mixed, [0.75, 1.0, 1.0]);
    }

    /// 凸性 ⇒ 白炉口径 ≤ max(双亲) ≤ 1:混合不产生新能量,双端白炉先验。
    #[test]
    fn furnace_bound_holds_for_both_modes() {
        for overlay in [false, true] {
            let response = LayerResponse { coverage: 0.75, overlay };
            assert!(furnace_bound_holds([0.9, 0.9, 0.9], &[([1.0, 0.4, 0.2], response)]));
        }
    }

    /// 层栈应用序合同:层 0 先混合,层 1 作用于层 0 的结果;交换次序结果不同。
    #[test]
    fn layer_application_order_is_array_order() {
        let l0 = ([0.0, 0.0, 0.0], LayerResponse { coverage: 0.5, overlay: false });
        let l1 = ([1.0, 1.0, 1.0], LayerResponse { coverage: 0.5, overlay: false });
        let forward = blend_layer_stack([0.5, 0.5, 0.5], &[l0, l1]);
        let backward = blend_layer_stack([0.5, 0.5, 0.5], &[l1, l0]);
        assert_eq!(forward, [0.625, 0.625, 0.625]);
        assert_ne!(forward, backward);
    }

    /// 零覆盖层在响应混合中逐位无扰动(与 GPU 剪枝合同一致)。
    #[test]
    fn zero_coverage_response_is_bitwise_pruned() {
        let base = [0.3, 0.6, 0.9];
        let layer = ([1.0, 1.0, 1.0], LayerResponse { coverage: 0.0, overlay: false });
        assert_eq!(blend_layer_stack(base, &[layer]), base);
    }

    /// 双端对拍:TS 权威端(scripts/i-c23-native-layered-fixture.mjs 产出)的
    /// 304B 块金标 + 混合闭式案例 + 白炉凸性,Rust 逐位对拍。
    /// fixture 由 Web 单源真函数生成,是对 wgsl/materialLayerBlend.wgsl
    /// checksum 门之外的第二道跨语言锚。
    #[test]
    fn native_pack_and_blend_match_ts_authority_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../deep-engine/fixtures/i-c23-native-layered-block-v1.json"
        ))
        .expect("layered fixture parses");
        assert_eq!(fixture["abi"], "deep.pbr.layered-surface.v1");
        assert_eq!(fixture["blockBytes"], 304);
        let rows = fixture_rows(&fixture["material"]);
        let block = pack_layered_surface_block(&rows);
        let expected: Vec<f64> = fixture["block"]
            .as_array()
            .expect("fixture block array")
            .iter()
            .map(|value| value.as_f64().expect("finite block float"))
            .collect();
        assert_eq!(expected.len(), LAYERED_SURFACE_BLOCK_FLOATS);
        for (index, value) in expected.iter().enumerate() {
            assert_eq!(
                block[index].to_bits(),
                f32::from(*value as f32).to_bits(),
                "block word {index} drifts from the TS authority"
            );
        }
        for case in fixture["blendCases"].as_array().expect("blend cases") {
            let underlying = rgb3(&case["underlying"]);
            let layer = rgb3(&case["layer"]);
            let coverage = case["coverage"].as_f64().unwrap() as f32;
            let overlay = case["overlay"].as_bool().unwrap();
            let blended = blend_rgb(underlying, layer, coverage, overlay);
            let expected = rgb3(&case["expected"]);
            for channel in 0..3 {
                assert_eq!(
                    blended[channel].to_bits(),
                    expected[channel].to_bits(),
                    "blend case channel {channel} drifts from the TS authority"
                );
            }
        }
        let furnace = &fixture["furnace"];
        let base = rgb3(&furnace["base"]);
        let layers: Vec<([f32; 3], LayerResponse)> = furnace["layers"]
            .as_array()
            .expect("furnace layers")
            .iter()
            .map(|layer| {
                (
                    rgb3(&layer["rgb"]),
                    LayerResponse {
                        coverage: layer["coverage"].as_f64().unwrap() as f32,
                        overlay: layer["overlay"].as_bool().unwrap(),
                    },
                )
            })
            .collect();
        assert_eq!(blend_layer_stack(base, &layers), rgb3(&furnace["blended"]));
        assert!(furnace_bound_holds(base, &layers));
    }

    fn rgb3(value: &serde_json::Value) -> [f32; 3] {
        let values: Vec<f64> = value
            .as_array()
            .expect("rgb triple")
            .iter()
            .map(|item| item.as_f64().expect("finite channel"))
            .collect();
        [values[0] as f32, values[1] as f32, values[2] as f32]
    }

    /// 从 fixture 的 TS 规范输入重建 Rust 打包行(UV 变换与 renderPacketMaterials
    /// 同式;fixture 固定 rotation=0,避免跨库三角函数位差)。
    fn fixture_rows(material: &serde_json::Value) -> Vec<LayeredBlockRow> {
        material["layers"]
            .as_array()
            .expect("fixture layers")
            .iter()
            .filter_map(|layer| {
                let coverage = layer["coverage"].as_f64().unwrap() as f32;
                (coverage > 0.0).then(|| LayeredBlockRow {
                    params: DEFAULT_LAYER_PARAMS,
                    coverage,
                    overlay: layer["mode"] == "overlay",
                    metal_reflection: layer["responseModel"] == "microfacet-metal-reflection",
                    color: layer["surface"]["baseColor"].as_array().map(|values| {
                        [
                            values[0].as_f64().unwrap() as f32,
                            values[1].as_f64().unwrap() as f32,
                            values[2].as_f64().unwrap() as f32,
                        ]
                    }),
                    metallic: layer["surface"]["metallic"].as_f64().map(|value| value as f32),
                    roughness: layer["surface"]["roughness"].as_f64().map(|value| value as f32),
                    base_color_texture: layer["surface"]["baseColorTexture"]
                        .as_object()
                        .map(fixture_binding),
                    metallic_roughness_texture: layer["surface"]["metallicRoughnessTexture"]
                        .as_object()
                        .map(fixture_binding),
                })
            })
            .collect()
    }

    fn fixture_binding(slot: &serde_json::Map<String, serde_json::Value>) -> LayerTextureBinding {
        let pair = |name: &str, fallback: [f64; 2]| -> [f32; 2] {
            slot.get(name)
                .and_then(|value| value.as_array())
                .map(|values| [values[0].as_f64().unwrap() as f32, values[1].as_f64().unwrap() as f32])
                .unwrap_or(fallback.map(|value| value as f32))
        };
        let [tx, ty] = pair("offset", [0.0, 0.0]);
        let [sx, sy] = pair("scale", [1.0, 1.0]);
        // rotation 恒 0(fixture 合同):c=1、s=0 精确,无跨库三角函数位差。
        let normalize = |value: f32| if value == 0.0 { 0.0 } else { value };
        LayerTextureBinding {
            uv_transform: [
                normalize(sx),
                normalize(-0.0 * sy),
                normalize(tx),
                normalize(0.0 * sx),
                normalize(sy),
                normalize(ty),
            ],
            tex_coord: slot.get("texCoord").and_then(|value| value.as_u64()).unwrap_or(0) as u8,
            array_layer: 0,
        }
    }
}
