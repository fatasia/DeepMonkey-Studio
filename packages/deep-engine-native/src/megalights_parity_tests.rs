//! P1 native MegaLights 双端对拍(TS 权威 fixture 的 Rust twin)。
//!
//! fixture 单源:`packages/deep-engine/fixtures/megalights-native-parity-v1.json`
//! (生成器 `packages/deep-engine/scripts/generateMegaLightsNativeParity.mts`,运行
//! TS 生产 CPU 权威链:packMegaLights → buildReservoirPassCpu → reuseAndShadePassCpu
//! → megaLightsExhaustiveReferenceCpu;黄金场景 8×6 像素 × 12 灯 × 5 帧覆盖矩阵:
//! 空间值域平均/时域合并/EMA/self 回落/穷举,含法线门失败与深度断裂分支)。
//!
//! 对拍纪律(与 sdf-gi 先例同构,跨 libm 面如实声明):
//! - **位级**:RNG 全流(u32 整数,单测锚)、蓄水池结构(winner/m)、灯池打包
//!   纯算术词、门逻辑、穷举帧的随机短路;
//! - **跨 libm 哨兵**(hypot/pow/exp2 在单灯评价内逐次出现,无法逐位):
//!   ①蓄水池 weightSum f64 相对 ≤1e-9;②胜者序列仍位级(场景取值避开
//!   uniform×total 比较边界);③f32 color 词 ≤2 ulp(f64 链 1e-9 传播后
//!   落点翻转裕度);④打包方向词(normalize 的 hypot)≤1 ulp。

use crate::megalights_ies::MegaLightsIesPacking;
use crate::megalights_ris::{
    DirectLightingPath, MEGA_LIGHT_ABI_VERSION, MEGA_LIGHT_KIND_AREA_RECT, MEGA_LIGHT_KIND_POINT,
    MEGA_LIGHT_KIND_SPOT, MEGA_LIGHT_STRIDE_BYTES, MEGA_LIGHT_WORDS, MEGALIGHTS_INVALID_LIGHT,
    MEGALIGHTS_RIS_CANDIDATES, MEGALIGHTS_SPATIAL_NORMAL_GATE, MEGALIGHTS_SPATIAL_REUSE_RADIUS,
    MEGALIGHTS_TEMPORAL_DEPTH_GATE, MegaLight, MegaLightKind, MegaLightsFrameConfig,
    MegaLightsFrameInput, MegaSurfaceRow, RisReservoir, build_reservoir_pass, evaluate_mega_light,
    finish_reservoir, mega_light_range_attenuation, mega_light_spot_cone,
    mega_lights_exhaustive_reference, mega_lights_exhaustive_reference_ies, mega_lights_frame,
    mega_shade_winner, mega_surface_decode, mega_target_weight, mega_view_depth, pack_mega_lights,
    reuse_and_shade_pass, sha256_of_words,
};
use crate::megalights_visibility::{MegaLightsVisibilityScene, winner_visibility_mask};
use crate::ray_backend::{TlasInstance, build_bvh};
use serde_json::Value;
use std::rc::Rc;

const FIXTURE: &str = include_str!("../../deep-engine/fixtures/megalights-native-parity-v1.json");

fn fixture() -> &'static Value {
    use std::sync::OnceLock;
    static FIXTURE_PARSED: OnceLock<Value> = OnceLock::new();
    FIXTURE_PARSED.get_or_init(|| serde_json::from_str(FIXTURE).expect("fixture must parse"))
}

fn vec3(value: &Value) -> [f64; 3] {
    std::array::from_fn(|index| value[index].as_f64().expect("fixture vec3"))
}

fn words(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("fixture words array")
        .iter()
        .map(|value| value.as_f64().expect("fixture word") as f32)
        .collect()
}

fn reservoirs(value: &Value) -> Vec<RisReservoir> {
    value
        .as_array()
        .expect("fixture reservoirs")
        .iter()
        .map(|entry| {
            let fields = entry.as_array().expect("reservoir triple");
            RisReservoir {
                weight_sum: fields[0].as_f64().expect("weightSum"),
                winner: fields[1].as_f64().expect("winner") as u32,
                m: fields[2].as_f64().expect("m") as u32,
            }
        })
        .collect()
}

fn parse_lights(fixture: &Value) -> Vec<MegaLight> {
    fixture["inputs"]["lights"]
        .as_array()
        .expect("fixture lights")
        .iter()
        .map(|entry| {
            let kind = match entry["kind"].as_str().expect("kind") {
                "point" => MegaLightKind::Point,
                "spot" => MegaLightKind::Spot,
                "area" => MegaLightKind::AreaRect,
                other => panic!("unknown fixture light kind {other}"),
            };
            let scalar = |key: &str, fallback: f64| entry[key].as_f64().unwrap_or(fallback);
            MegaLight {
                kind,
                position_view: vec3(&entry["positionView"]),
                range: entry["range"].as_f64().expect("range"),
                color: vec3(&entry["color"]),
                intensity: entry["intensity"].as_f64().expect("intensity"),
                decay: scalar("decay", 2.0),
                direction_view: entry["directionView"]
                    .as_array()
                    .map(|values| -> [f64; 3] {
                        std::array::from_fn(|index| values[index].as_f64().expect("direction"))
                    })
                    .unwrap_or([0.0, 0.0, 1.0]),
                inner_cone_cos: scalar("innerConeCos", 1.0),
                outer_cone_cos: scalar("outerConeCos", -1.0),
                half_extent: entry["halfExtent"]
                    .as_array()
                    .map(|values| {
                        [
                            values[0].as_f64().expect("hw"),
                            values[1].as_f64().expect("hh"),
                        ]
                    })
                    .unwrap_or([0.0, 0.0]),
                two_sided: entry["twoSided"].as_bool().unwrap_or(false),
                ies_spot_index: entry["iesSpotIndex"].as_u64().map(|value| value as u32),
            }
        })
        .collect()
}

/// fixture `inputs.iesPacked`(E02 打包 vec4 字流)→ IES 载荷视图(测试进程期存活)。
fn fixture_ies(fixture: &Value) -> MegaLightsIesPacking<'static> {
    let words: Vec<f32> = fixture["inputs"]["iesPacked"]
        .as_array()
        .expect("fixture iesPacked")
        .iter()
        .map(|value| value.as_f64().expect("ies word") as f32)
        .collect();
    let spot_count = fixture["inputs"]["iesSpotCount"]
        .as_u64()
        .expect("iesSpotCount") as usize;
    MegaLightsIesPacking::new(Box::leak(words.into_boxed_slice()), spot_count)
}

fn parse_surfaces(fixture: &Value) -> Vec<MegaSurfaceRow> {
    fixture["inputs"]["surfaces"]
        .as_array()
        .expect("fixture surfaces")
        .iter()
        .map(|row| {
            std::array::from_fn(|index| {
                let vec4 = row[index].as_array().expect("surface vec4");
                std::array::from_fn(|slot| vec4[slot].as_f64().expect("surface word"))
            })
        })
        .collect()
}

fn assert_words_within_ulp(actual: &[f32], expected: &[f32], label: &str, ulps: f64) {
    assert_eq!(actual.len(), expected.len(), "{label} word count drift");
    for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(
            actual.is_nan(),
            expected.is_nan(),
            "{label}[{index}] NaN drift"
        );
        if actual.is_nan() {
            continue;
        }
        if actual == expected {
            continue;
        }
        // 1 ulp ≈ f32::EPSILON(相对);上限按倍数放行。
        let distance = (f64::from(*actual) - f64::from(*expected)).abs()
            / f64::max(f64::from(expected.abs()), f64::from(f32::EPSILON));
        assert!(
            distance <= ulps * f32::EPSILON as f64,
            "{label}[{index}] word drift {actual} vs {expected} (> {ulps} ulp)"
        );
    }
}

struct FrameBorrow<'a> {
    motion_uv: Option<&'a [f64]>,
    visibility: Option<&'a [f32]>,
}

#[allow(clippy::too_many_arguments)]
fn parse_frame_input<'a>(
    fixture: &Value,
    frame: &Value,
    lights: &'a [MegaLight],
    surfaces: &'a [MegaSurfaceRow],
    previous: Option<&'a [RisReservoir]>,
    previous_color: Option<&'a [f32]>,
    borrow: &FrameBorrow<'a>,
    ies: Option<&'a MegaLightsIesPacking<'a>>,
) -> MegaLightsFrameInput<'a> {
    let width = fixture["inputs"]["width"].as_u64().expect("width") as u32;
    let height = fixture["inputs"]["height"].as_u64().expect("height") as u32;
    let with_motion = frame["withMotion"].as_bool().unwrap_or(false);
    let with_visibility = frame["withVisibility"].as_bool().unwrap_or(false);
    let with_ies = frame["withIes"].as_bool().unwrap_or(false);
    MegaLightsFrameInput {
        lights,
        surfaces,
        previous,
        motion_uv: if with_motion { borrow.motion_uv } else { None },
        previous_color,
        visibility: if with_visibility {
            borrow.visibility
        } else {
            None
        },
        ies: if with_ies { ies } else { None },
        frame: frame["frame"].as_u64().expect("frame") as u32,
        config: MegaLightsFrameConfig {
            width,
            height,
            candidate_count: Some(MEGALIGHTS_RIS_CANDIDATES),
            temporal: frame["temporal"].as_bool().unwrap_or(true),
            spatial: frame["spatial"].as_bool().unwrap_or(true),
            exhaustive: frame["exhaustive"].as_bool().unwrap_or(false),
            alpha_blend: None,
        },
    }
}

fn fixture_motion(fixture: &Value) -> Vec<f64> {
    fixture["inputs"]["motion"]
        .as_array()
        .expect("fixture motion")
        .iter()
        .map(|value| value.as_f64().expect("motion"))
        .collect()
}

fn fixture_visibility(fixture: &Value) -> Vec<f32> {
    fixture["inputs"]["visibility"]
        .as_array()
        .expect("fixture visibility")
        .iter()
        .map(|value| value.as_f64().expect("visibility") as f32)
        .collect()
}

/// 灯池 64B ABI:纯算术词位级;方向词(normalize 的 hypot 跨 libm)≤1 ulp。
#[test]
fn golden_packing_matches_ts_wordwise() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let packed = pack_mega_lights(&lights);
    let expected = words(&fixture["packed"]["data"]);
    assert_eq!(expected.len(), lights.len() * MEGA_LIGHT_WORDS);
    assert_eq!(packed.data.len(), expected.len());
    for (index, (actual, expected)) in packed.data.iter().zip(&expected).enumerate() {
        if actual == expected {
            continue;
        }
        // 方向槽(base+8..11):normalize hypot 哨兵 ≤1 ulp;其余词必须逐位。
        let slot = index % MEGA_LIGHT_WORDS;
        let is_direction_slot = (8..11).contains(&slot);
        let distance = (f64::from(*actual) - f64::from(*expected)).abs()
            / f64::max(f64::from(expected.abs()), f32::EPSILON.into());
        assert!(
            is_direction_slot && distance <= f32::EPSILON as f64,
            "packed word [{index}] slot {slot} drift {actual} vs {expected}"
        );
    }
    assert_eq!(
        sha256_of_words(&packed.data),
        fixture["packed"]["sha256"].as_str().expect("packed sha"),
        "sha256 哨兵:方向词 1 ulp 内的跨 libm 翻转仍会改写指纹,如实记录差异"
    );
    assert_eq!(
        packed.count,
        fixture["packed"]["count"].as_u64().unwrap() as usize
    );
    assert_eq!(
        packed.point_count,
        fixture["packed"]["pointCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        packed.spot_count,
        fixture["packed"]["spotCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        packed.area_count,
        fixture["packed"]["areaCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        packed.ies_reference_count,
        fixture["packed"]["iesReferenceCount"].as_u64().unwrap() as usize,
        "IES 行号引用计数(64B ABI 字 11 启用后的闭合校验位)"
    );
}

/// IES 因子向量黄金腿(2026-10-06):fixture `iesFactorVectors` 的 TS 真值
/// (evaluateIesShadingFactor)位级对拍——因子 = f32 展开值 × f32 scale 的 f64 乘积,
/// 双端精确;角度经 0.5° 网格量化吸收 acos/atan2 的跨 libm ULP(向量取值避开半度中点)。
#[test]
fn ies_factor_vectors_match_ts_bit_level() {
    let fixture = fixture();
    let ies = fixture_ies(fixture);
    for (index, vector) in fixture["iesFactorVectors"]
        .as_array()
        .expect("ies factor vectors")
        .iter()
        .enumerate()
    {
        let spot_index = vector["spotIndex"].as_u64().expect("spotIndex") as usize;
        let vec3 = |key: &str| -> [f64; 3] {
            let values = vector[key].as_array().expect(key);
            std::array::from_fn(|slot| values[slot].as_f64().expect("component"))
        };
        let factor = crate::megalights_ies::evaluate_ies_shading_factor(
            &ies,
            spot_index,
            vec3("lightDirection"),
            vec3("surfaceToLight"),
        );
        let expected = vector["factor"].as_f64().expect("factor");
        assert_eq!(
            factor, expected,
            "ies factor vector [{index}] spot {spot_index} drift {factor} vs {expected}"
        );
    }
    // 载荷闭合:fixture spot 计数与打包字 11(行号+1)与灯池字位一致。
    let lights = parse_lights(fixture);
    let packed = pack_mega_lights(&lights);
    for (index, light) in lights.iter().enumerate() {
        let expected = light.ies_spot_index.map_or(0.0f32, |row| (row + 1) as f32);
        assert_eq!(
            packed.data[index * MEGA_LIGHT_WORDS + 11],
            expected,
            "ies word drift at light {index}"
        );
    }
}

/// 胜者可见性 mask 黄金腿(2026-10-06 可见性射线档):两级 TLAS 遮挡对拍——
/// fixture `winnerVisibility.maskGolden` 由 TS 权威 traceTlasClosest 仲裁生成
/// (GPU 两级追踪的仲裁基准;boolean 语义无跨 libm 面),native 从同一场景重放:
/// frame 0 胜者蓄水池 → 胜者射线(origin 外推 + tMax 双侧收缩,相对偏移 1e-3)
/// → 两级遮挡 → mask 逐像素相等。
#[test]
fn winner_visibility_mask_matches_ts_golden() {
    let fixture = fixture();
    let visibility = &fixture["winnerVisibility"];
    let frame_index = visibility["frameIndex"].as_u64().expect("frameIndex") as usize;
    let view_to_world: [f32; 16] = std::array::from_fn(|slot| {
        visibility["viewToWorld"][slot]
            .as_f64()
            .expect("viewToWorld word") as f32
    });
    let ray_mask =
        u32::try_from(visibility["rayMask"].as_u64().expect("rayMask")).expect("u32 mask");
    assert!(
        (visibility["biasRelative"].as_f64().expect("biasRelative")
            - crate::megalights_visibility::MEGA_LIGHTS_VISIBILITY_RAY_BIAS_RELATIVE)
            .abs()
            < 1e-15,
        "relative bias contract drift"
    );
    let occluder = &visibility["occluder"];
    let vertices: Vec<f32> = occluder["vertices"]
        .as_array()
        .expect("occluder vertices")
        .iter()
        .map(|value| value.as_f64().expect("vertex") as f32)
        .collect();
    let indices: Vec<u32> = occluder["indices"]
        .as_array()
        .expect("occluder indices")
        .iter()
        .map(|value| u32::try_from(value.as_u64().expect("index")).expect("u32"))
        .collect();
    let world_to_local: [f32; 12] = std::array::from_fn(|slot| {
        occluder["worldToLocal"][slot]
            .as_f64()
            .expect("worldToLocal word") as f32
    });
    let instance_mask =
        u32::try_from(occluder["mask"].as_u64().expect("occluder mask")).expect("u32");
    let blas = build_bvh(&vertices, &indices).expect("occluder blas builds");
    let instances = vec![TlasInstance {
        id: occluder["id"].as_u64().expect("occluder id") as u32,
        blas_vertices: Rc::new(vertices),
        blas_indices: Rc::new(indices),
        blas,
        world_to_local,
        mask: instance_mask,
    }];
    let scene = MegaLightsVisibilityScene {
        instances: &instances,
        ray_mask,
    };
    // frame[frameIndex] 蓄水池重放(与 golden frames 腿同输入:IES + motion/visibility 布尔)。
    let lights = parse_lights(fixture);
    let surfaces = parse_surfaces(fixture);
    let owned_motion = fixture_motion(fixture);
    let owned_visibility = fixture_visibility(fixture);
    let borrow = FrameBorrow {
        motion_uv: Some(&owned_motion),
        visibility: Some(&owned_visibility),
    };
    let ies = fixture_ies(fixture);
    let frame = &fixture["frames"].as_array().expect("frames")[frame_index];
    let input = parse_frame_input(
        fixture,
        frame,
        &lights,
        &surfaces,
        None,
        None,
        &borrow,
        Some(&ies),
    );
    let built = build_reservoir_pass(&input);
    let mask = winner_visibility_mask(&lights, &surfaces, &built, &view_to_world, Some(&scene));
    let golden: Vec<f64> = visibility["maskGolden"]
        .as_array()
        .expect("maskGolden")
        .iter()
        .map(|value| value.as_f64().expect("mask word"))
        .collect();
    assert_eq!(mask.len(), golden.len(), "mask pixel count drift");
    for (pixel, (actual, expected)) in mask.iter().zip(&golden).enumerate() {
        assert_eq!(
            f64::from(*actual),
            *expected,
            "visibility mask drift at pixel {pixel}"
        );
    }
    // fail-closed 腿:同输入无场景 → 全 1(= 旧行为)。
    let fallback = winner_visibility_mask(&lights, &surfaces, &built, &view_to_world, None);
    assert!(
        fallback.iter().all(|value| *value == 1.0),
        "no-scene fallback must be all visible"
    );
}

/// ABI 常量互钉(与 TS megaLights.ts/megaLightsAbi.ts 词汇)。
#[test]
fn abi_constants_match_ts_contract() {
    assert_eq!(MEGA_LIGHT_ABI_VERSION, 1);
    assert_eq!(MEGA_LIGHT_STRIDE_BYTES, 64);
    assert_eq!(MEGA_LIGHT_WORDS, 16);
    assert_eq!(MEGA_LIGHT_KIND_POINT, 0);
    assert_eq!(MEGA_LIGHT_KIND_SPOT, 1);
    assert_eq!(MEGA_LIGHT_KIND_AREA_RECT, 2);
    assert_eq!(MEGALIGHTS_RIS_CANDIDATES, 32);
    assert_eq!(MEGALIGHTS_SPATIAL_REUSE_RADIUS, 2);
    assert_eq!(MEGALIGHTS_TEMPORAL_DEPTH_GATE, 0.1);
    assert_eq!(MEGALIGHTS_SPATIAL_NORMAL_GATE, 0.9);
    assert_eq!(MEGALIGHTS_INVALID_LIGHT, 0xffff_ffff);
}

/// 衰减/聚光锥标量核 vs fixture 场景抽样(TS megaLightRangeAttenuationCpu /
/// megaLightSpotConeCpu 哨兵对拍)。
#[test]
fn scalar_kernels_track_ts_semantics() {
    // range 衰减三支:无窗口 / 窗口外 / decay 2 特式 / 一般 decay。
    assert!(mega_light_range_attenuation(4.0, 0.0, 2.0) > 0.0);
    assert_eq!(mega_light_range_attenuation(25.0, 4.0, 2.0), 0.0);
    let windowed = mega_light_range_attenuation(1.0, 4.0, 2.0);
    let ratio: f64 = 1.0 / 16.0;
    let window: f64 = 1.0 - ratio * ratio;
    assert!((windowed - window * window / 1.0).abs() < 1e-12);
    assert!(mega_light_range_attenuation(1.0, 4.0, 3.0) > 0.0);
    // 聚光锥:coneScale=0 的阶跃分支与 smoothstep 中点。
    assert_eq!(mega_light_spot_cone(0.7, 0.7, 0.0), 1.0);
    assert_eq!(mega_light_spot_cone(0.4, 0.7, 0.0), 0.0);
    assert!((mega_light_spot_cone(0.6, 0.5, 2.0) - 0.104).abs() < 1e-12);
    assert!((mega_light_spot_cone(0.75, 0.5, 2.0) - 0.5).abs() < 1e-12);
}

/// 单灯评价端到端:目标权重 = luminance(贡献);胜者着色按可见性缩放 shade 侧
/// (TS megaTargetWeightCpu/megaShadeWinnerCpu 同位;哨兵 ≤1e-9 相对)。
#[test]
fn evaluation_semantics_match_ts_weight_and_shade() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let surfaces = parse_surfaces(fixture);
    for index in 0..lights.len() {
        let weight = mega_target_weight(&lights, &surfaces[0], index);
        let shade = mega_shade_winner(&lights, &surfaces[0], index, 1.0);
        let luminance = 0.2126 * shade[0] + 0.7152 * shade[1] + 0.0722 * shade[2];
        assert!(
            (weight - luminance).abs() <= 1e-9 * f64::max(1.0, luminance.abs()),
            "target weight must equal shade luminance at light {index}"
        );
        let dimmed = mega_shade_winner(&lights, &surfaces[0], index, 0.0);
        assert_eq!(
            dimmed, [0.0; 3],
            "visibility 0 must zero shade at light {index}"
        );
        // 表面解码:视深 = -z;w 槽截断(metallic/roughness)。
        let (_, _, view, _, metallic, roughness) = mega_surface_decode(&surfaces[0]);
        assert_eq!(mega_view_depth(&surfaces[0]), -surfaces[0][0][2]);
        assert_eq!(metallic, surfaces[0][0][3]);
        assert_eq!(roughness, surfaces[0][1][3]);
        let view_length = f64::hypot(f64::hypot(view[0], view[1]), view[2]);
        assert!(
            (view_length - 1.0).abs() < 1e-12,
            "decoded view must be unit"
        );
        let _ = evaluate_mega_light(&lights[index], &surfaces[0]);
    }
    // 蓄水池收尾公式:W_Y = N·w_sum/(m·t_y)。
    let reservoir = RisReservoir {
        weight_sum: 8.0,
        winner: 0,
        m: 2,
    };
    let weight_y = mega_target_weight(&lights, &surfaces[0], 0);
    let expected = 12.0 * 8.0 / (2.0 * weight_y);
    let finished = finish_reservoir(&reservoir, &lights, &surfaces[0], lights.len());
    assert!((finished - expected).abs() <= 1e-9 * f64::max(1.0, expected.abs()));
    let invalid = finish_reservoir(
        &RisReservoir {
            weight_sum: 8.0,
            winner: MEGALIGHTS_INVALID_LIGHT,
            m: 2,
        },
        &lights,
        &surfaces[0],
        lights.len(),
    );
    assert_eq!(invalid, 0.0);
}

/// 全帧链逐帧对拍:蓄水池结构位级 + weightSum ≤1e-9 相对 + color 词 ≤2 ulp。
#[test]
fn golden_frames_match_ts_structure_and_words() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let surfaces = parse_surfaces(fixture);
    let tolerance = &fixture["tolerance"];
    let scalar_rel = tolerance["scalarRel"].as_f64().expect("scalarRel");
    let color_ulps = tolerance["colorWordUlp"].as_f64().expect("colorWordUlp");
    let owned_motion = fixture_motion(fixture);
    let owned_visibility = fixture_visibility(fixture);
    let borrow = FrameBorrow {
        motion_uv: Some(&owned_motion),
        visibility: Some(&owned_visibility),
    };
    let mut replayed: Vec<(Vec<RisReservoir>, Vec<f32>)> = Vec::new();
    let ies = fixture_ies(fixture);
    for (index, frame) in fixture["frames"]
        .as_array()
        .expect("frames")
        .iter()
        .enumerate()
    {
        let (previous, previous_color) = if index == 0 {
            (None, None)
        } else {
            let (reservoirs, color) = &replayed[index - 1];
            (Some(reservoirs.as_slice()), Some(color.as_slice()))
        };
        let input = parse_frame_input(
            fixture,
            frame,
            &lights,
            &surfaces,
            previous,
            previous_color,
            &borrow,
            Some(&ies),
        );
        let built = build_reservoir_pass(&input);
        let output = reuse_and_shade_pass(&input, &built);
        // 趟一蓄水池(结构位级 + f64 标量哨兵)。
        let expected_built = reservoirs(&frame["built"]);
        assert_eq!(built.len(), expected_built.len());
        for (pixel, (actual, expected)) in built.iter().zip(&expected_built).enumerate() {
            assert_eq!(
                actual.winner, expected.winner,
                "frame {index} pixel {pixel} winner drift"
            );
            assert_eq!(actual.m, expected.m, "frame {index} pixel {pixel} m drift");
            assert!(
                (actual.weight_sum - expected.weight_sum).abs()
                    <= scalar_rel * f64::max(1.0, expected.weight_sum.abs()),
                "frame {index} pixel {pixel} weightSum drift {} vs {}",
                actual.weight_sum,
                expected.weight_sum
            );
        }
        // 输出蓄水池 = 趟一 self 状态(趟二不改写;哨兵与 built 同款)。
        let expected_reservoirs = reservoirs(&frame["reservoirs"]);
        assert_eq!(output.reservoirs.len(), expected_reservoirs.len());
        for (pixel, (actual, expected)) in output
            .reservoirs
            .iter()
            .zip(&expected_reservoirs)
            .enumerate()
        {
            assert_eq!(
                actual.winner, expected.winner,
                "frame {index} pixel {pixel} output winner drift"
            );
            assert_eq!(
                actual.m, expected.m,
                "frame {index} pixel {pixel} output m drift"
            );
            assert!(
                (actual.weight_sum - expected.weight_sum).abs()
                    <= scalar_rel * f64::max(1.0, expected.weight_sum.abs()),
                "frame {index} pixel {pixel} output weightSum drift {} vs {}",
                actual.weight_sum,
                expected.weight_sum
            );
        }
        // 颜色词(≤2 ulp 哨兵)。
        let expected_color = words(&frame["colorWords"]);
        assert_eq!(output.color.len(), expected_color.len());
        assert_words_within_ulp(
            &output.color,
            &expected_color,
            &format!("frame {index} color"),
            color_ulps,
        );
        replayed.push((output.reservoirs, output.color));
    }
}

/// 穷举参考位级腿(无 RNG;逐灯求和哨兵同 color;参考与穷举帧同口径消费 IES)。
#[test]
fn golden_exhaustive_reference_matches_ts_words() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let surfaces = parse_surfaces(fixture);
    let width = fixture["inputs"]["width"].as_u64().unwrap() as u32;
    let height = fixture["inputs"]["height"].as_u64().unwrap() as u32;
    let ies = fixture_ies(fixture);
    let reference =
        mega_lights_exhaustive_reference_ies(&lights, &surfaces, width, height, Some(&ies));
    let expected = words(&fixture["exhaustiveReference"]["colorWords"]);
    assert_eq!(reference.len(), expected.len());
    let color_ulps = fixture["tolerance"]["colorWordUlp"].as_f64().unwrap();
    assert_words_within_ulp(&reference, &expected, "exhaustive reference", color_ulps);
    // 无 IES 参考与带 IES 参考必须不同(fixture 场景 IES 因子非平凡——注入生效的独立证据)。
    let identity = mega_lights_exhaustive_reference(&lights, &surfaces, width, height);
    assert_ne!(
        identity, reference,
        "IES injection must perturb the golden scene (identity reference == ies reference means the factor leg is inert)"
    );
}

/// 穷举帧(K≥N)输出恒等于穷举精确参考(⑤ 退化一致性;TS megaLightsFrameCpu 同腿)。
#[test]
fn exhaustive_frame_equals_reference_within_sentinel() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let surfaces = parse_surfaces(fixture);
    let width = fixture["inputs"]["width"].as_u64().unwrap() as u32;
    let height = fixture["inputs"]["height"].as_u64().unwrap() as u32;
    let exhaustive_frame = fixture["frames"]
        .as_array()
        .unwrap()
        .iter()
        .find(|frame| frame["exhaustive"].as_bool().unwrap_or(false))
        .expect("fixture must contain an exhaustive frame");
    let owned_motion = fixture_motion(fixture);
    let owned_visibility = fixture_visibility(fixture);
    let borrow = FrameBorrow {
        motion_uv: Some(&owned_motion),
        visibility: Some(&owned_visibility),
    };
    let ies = fixture_ies(fixture);
    let input = parse_frame_input(
        fixture,
        exhaustive_frame,
        &lights,
        &surfaces,
        None,
        None,
        &borrow,
        Some(&ies),
    );
    let output = mega_lights_frame(&input);
    let reference =
        mega_lights_exhaustive_reference_ies(&lights, &surfaces, width, height, Some(&ies));
    assert_eq!(output.color.len(), reference.len());
    for (index, (actual, expected)) in output.color.iter().zip(&reference).enumerate() {
        assert!(
            (f64::from(*actual) - f64::from(*expected)).abs()
                <= 1e-6 * f64::max(1.0, f64::from(expected.abs())),
            "exhaustive frame vs reference drift at word {index}: {actual} vs {expected}"
        );
    }
}

/// 统计腿(fixture 权威对拍):50 个独立帧种子的逐像素均值 vs TS 权威
/// seedAveraged.mean(f64 全精度,≤1e-9 相对)——K=32 单帧在 HDR 灯跨度下方差大,
/// 均值域才是跨端可比的统计收敛域;无偏性由「TS 均值 ≈ 穷举参考」背书(本测试
/// 同时钉量级腿:均值 vs 参考的相对偏差 ≤50%,场景方差属性的诚实上限)。
#[test]
fn seed_averaged_mean_matches_ts_authority() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let surfaces = parse_surfaces(fixture);
    let width = fixture["inputs"]["width"].as_u64().unwrap() as u32;
    let height = fixture["inputs"]["height"].as_u64().unwrap() as u32;
    let pixels = (width * height) as usize;
    let seeds = fixture["seedAveraged"]["seeds"].as_u64().expect("seeds") as u32;
    let expected_mean: Vec<f64> = fixture["seedAveraged"]["mean"]
        .as_array()
        .expect("seed averaged mean")
        .iter()
        .map(|value| value.as_f64().expect("mean value"))
        .collect();
    assert_eq!(expected_mean.len(), pixels * 3);
    let owned_motion = fixture_motion(fixture);
    let owned_visibility = fixture_visibility(fixture);
    let borrow = FrameBorrow {
        motion_uv: Some(&owned_motion),
        visibility: Some(&owned_visibility),
    };
    let ies = fixture_ies(fixture);
    let mut mean = vec![0.0f64; pixels * 3];
    for seed in 0..seeds {
        let frame = serde_json::json!({
            "frame": 1000 + seed,
            "exhaustive": false,
            "spatial": true,
            "temporal": false,
            "withMotion": false,
            "withVisibility": false,
            "withIes": true,
        });
        let input = parse_frame_input(
            fixture,
            &frame,
            &lights,
            &surfaces,
            None,
            None,
            &borrow,
            Some(&ies),
        );
        let output = mega_lights_frame(&input);
        for (index, word) in output.color.iter().enumerate() {
            mean[index] += f64::from(*word) / f64::from(seeds);
        }
    }
    for (index, (actual, expected)) in mean.iter().zip(&expected_mean).enumerate() {
        assert!(
            (actual - expected).abs() <= 1e-9 * f64::max(1.0, expected.abs()),
            "seed mean drift at word {index}: {actual} vs {expected}"
        );
    }
    // 量级关系不设硬门:黄金场景为覆盖三灯型/门分支而稀疏,空间复用的门控
    // 残差在灯分布陡变像素上跨帧同号(双端同残差,fixture 均值对拍已背书一致);
    // 估计器无偏性的独立证明见 megalights_ris::tests::
    // ris_estimator_unbiased_over_independent_seeds(TS 同款口径)。
}

/// 直射通路组合:超预算走 RIS、预算内走既有簇光(与 native clustered_lighting
/// 的组合语义;TS resolveDirectLightingPath 同词汇,单测已锚——此处钉 fixture
/// 场景灯数决策一致性)。
#[test]
fn golden_scene_local_light_count_decides_cluster_path() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let points = lights
        .iter()
        .filter(|light| light.kind == MegaLightKind::Point)
        .count();
    let spots = lights
        .iter()
        .filter(|light| light.kind == MegaLightKind::Spot)
        .count();
    let areas = lights
        .iter()
        .filter(|light| light.kind == MegaLightKind::AreaRect)
        .count();
    assert_eq!(
        (points, spots, areas),
        (5, 4, 3),
        "golden scene composition drift"
    );
    // 9 盏本地灯 ≤ 64 → fixture 场景本身走簇光快路径;RIS 腿由显式 force 驱动
    // (与 TS megaLightsAcceptance 的 forceMegaLights 对拍模式同款)。
    let decision =
        crate::megalights_ris::resolve_direct_lighting_path(points, spots, areas, false, None);
    assert_eq!(decision.path, DirectLightingPath::ClusterForwardPlus);
    let forced =
        crate::megalights_ris::resolve_direct_lighting_path(points, spots, areas, true, None);
    assert_eq!(forced.path, DirectLightingPath::MegalightsRis);
}
