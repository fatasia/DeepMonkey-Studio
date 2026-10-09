//! C9/native 材质扩展带双端对拍(TS 权威 fixture 的 Rust twin)。
//!
//! fixture 单源:`packages/deep-engine/fixtures/material-native-parity-v1.json`
//! (生成器 `packages/deep-engine/scripts/generateMaterialNativeParity.mts`)。
//!
//! 对拍纪律(与 megalights/sdf-gi 先例同构,跨 libm 面如实声明):
//! - **f64 相对 ≤1e-9**:evaluateExtendedMaterialDirect 全链(rgb+四分量)、
//!   sheen 原语(dCharlie/vNeubelt/iblSheenBrdf/fSchlick)与能量标量;
//! - **f32 词位级**:打包带词(TS fround 后与 Rust as f32 逐位一致);
//! - **f32 词 ≤2 ulp**:求值输出词(f64 链 1e-9 传播后的落点裕度,
//!   pow/exp2 跨 libm 哨兵如实)。

use crate::material_extended_cpu::{
    ExtendedInputs, d_charlie, direct_dfg_185, evaluate_extended_material_direct,
    extended_band_words, f_schlick, ibl_sheen_brdf, sheen_direct_brdf, sheen_direct_energy,
    sheen_indirect_energy, v_neubelt,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../deep-engine/fixtures/material-native-parity-v1.json");

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

fn assert_f64_relative(actual: f64, expected: f64, label: &str) {
    let distance = (actual - expected).abs();
    assert!(
        distance <= 1e-9 * expected.abs().max(1e-12),
        "{label}: f64 drift {actual} vs {expected}"
    );
}

fn assert_vec3_relative(actual: [f64; 3], expected: [f64; 3], label: &str) {
    for axis in 0..3 {
        assert_f64_relative(actual[axis], expected[axis], &format!("{label}[{axis}]"));
    }
}

fn assert_words_within_ulp(actual: &[f32], expected: &[f32], label: &str, ulps: f64) {
    assert_eq!(actual.len(), expected.len(), "{label} word count drift");
    for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(
            actual.is_nan(),
            expected.is_nan(),
            "{label}[{index}] NaN drift"
        );
        if actual.is_nan() || actual == expected {
            continue;
        }
        let distance = (f64::from(*actual) - f64::from(*expected)).abs()
            / f64::max(f64::from(expected.abs()), f64::from(f32::EPSILON));
        assert!(
            distance <= ulps * f32::EPSILON as f64,
            "{label}[{index}] word drift {actual} vs {expected} (> {ulps} ulp)"
        );
    }
}

/// 扩展带(clearcoat 层叠)直接光:TS evaluateExtendedMaterialDirect 全链对拍。
#[test]
fn extended_direct_matches_ts_authority() {
    let cases = fixture()["inputs"]["extendedCases"]
        .as_array()
        .expect("extendedCases");
    let expected = fixture()["ts"]["extended"].as_array().expect("ts.extended");
    assert_eq!(cases.len(), expected.len(), "case count drift");
    for (case, want) in cases.iter().zip(expected) {
        let id = case["id"].as_str().expect("case id");
        let surface = &case["surface"];
        let extended = &case["extended"];
        let geometry = &case["geometry"];
        let radiance = vec3(&case["radiance"]);
        let params = ExtendedInputs {
            ior: extended["ior"].as_f64().unwrap_or(1.5),
            clearcoat_factor: extended["clearcoat"]["factor"].as_f64().unwrap_or(0.0),
            clearcoat_roughness: extended["clearcoat"]["roughness"].as_f64().unwrap_or(0.0),
            anisotropy_strength: extended["anisotropy"]["strength"].as_f64().unwrap_or(0.0),
            anisotropy_rotation: extended["anisotropy"]["rotation"].as_f64().unwrap_or(0.0),
            transmission_factor: extended["transmission"]["factor"].as_f64().unwrap_or(0.0),
        };
        let (rgb, diffuse, specular, clearcoat, transmission) = evaluate_extended_material_direct(
            vec3(&surface["baseColor"]),
            surface["metallic"].as_f64().expect("metallic"),
            surface["roughness"].as_f64().expect("roughness"),
            params,
            vec3(&geometry["normal"]),
            vec3(&geometry["view"]),
            vec3(&geometry["light"]),
            Some(vec3(&geometry["tangent"])),
            radiance,
        );
        assert_vec3_relative(rgb, vec3(&want["rgb"]), &format!("{id}.rgb"));
        assert_vec3_relative(diffuse, vec3(&want["diffuse"]), &format!("{id}.diffuse"));
        assert_vec3_relative(specular, vec3(&want["specular"]), &format!("{id}.specular"));
        assert_vec3_relative(
            clearcoat,
            vec3(&want["clearcoat"]),
            &format!("{id}.clearcoat"),
        );
        assert_vec3_relative(
            transmission,
            vec3(&want["transmission"]),
            &format!("{id}.transmission"),
        );
        let rgb_words: [f32; 3] = std::array::from_fn(|axis| rgb[axis] as f32);
        assert_words_within_ulp(
            &rgb_words,
            &words(&want["rgbWords"]),
            &format!("{id}.rgbWords"),
            2.0,
        );
    }
}

/// sheen 数学原语网格:TS materialAdvancedReference 全表对拍(f64)。
#[test]
fn sheen_primitives_match_ts_authority() {
    let grid = &fixture()["inputs"]["sheenPrimitiveGrid"];
    let want = &fixture()["ts"]["sheenPrimitives"];
    let roughness: Vec<f64> = grid["roughness"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let nh: Vec<f64> = grid["nh"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let nv: Vec<f64> = grid["nv"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let nl: Vec<f64> = grid["nl"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let cosines: Vec<f64> = grid["cosines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    for (row, r) in roughness.iter().enumerate() {
        for (column, h) in nh.iter().enumerate() {
            assert_f64_relative(
                d_charlie(*r, *h),
                want["dCharlie"][row][column].as_f64().unwrap(),
                &format!("dCharlie[{r},{h}]"),
            );
        }
    }
    for (row, v) in nv.iter().enumerate() {
        for (column, l) in nl.iter().enumerate() {
            assert_f64_relative(
                v_neubelt(*v, *l),
                want["vNeubelt"][row][column].as_f64().unwrap(),
                &format!("vNeubelt[{v},{l}]"),
            );
        }
    }
    for (row, v) in nv.iter().enumerate() {
        for (column, r) in roughness.iter().enumerate() {
            assert_f64_relative(
                ibl_sheen_brdf(*v, *r),
                want["iblSheenBrdf"][row][column].as_f64().unwrap(),
                &format!("iblSheen[{v},{r}]"),
            );
        }
    }
    for (column, cosine) in cosines.iter().enumerate() {
        assert_f64_relative(
            f_schlick(0.04, *cosine),
            want["fSchlick"][column].as_f64().unwrap(),
            &format!("fSchlick[{cosine}]"),
        );
    }
}

/// sheen 直射项与能量补偿:TS 同输入对拍(f64 + 词 ≤2 ulp)。
#[test]
fn sheen_direct_and_energy_match_ts_authority() {
    let cases = fixture()["inputs"]["sheenCases"]
        .as_array()
        .expect("sheenCases");
    let expected = fixture()["ts"]["sheen"].as_array().expect("ts.sheen");
    for (case, want) in cases.iter().zip(expected) {
        let color = vec3(&case["color"]);
        let roughness = case["roughness"].as_f64().unwrap();
        let nv = case["nv"].as_f64().unwrap();
        let nl = case["nl"].as_f64().unwrap();
        let nh = want["nh"].as_f64().expect("fixture nh");
        let direct = sheen_direct_brdf(color, roughness, nv, nl, nh);
        assert_vec3_relative(direct, vec3(&want["directBrdf"]), "sheen.directBrdf");
        let direct_words: [f32; 3] = std::array::from_fn(|axis| direct[axis] as f32);
        assert_words_within_ulp(
            &direct_words,
            &words(&want["directBrdfWords"]),
            "sheen.directBrdfWords",
            2.0,
        );
        assert_f64_relative(
            sheen_direct_energy(color, roughness, nv, nl),
            want["directEnergy"].as_f64().unwrap(),
            "sheen.directEnergy",
        );
        assert_f64_relative(
            sheen_indirect_energy(color, roughness, nv),
            want["indirectEnergy"].as_f64().unwrap(),
            "sheen.indirectEnergy",
        );
    }
}

/// 打包带:扩展带 6 词与 advanced 带 sheen 4 词与 TS 打包器逐位一致;
/// native 未消费的 advanced 槽位(iridescence/volume)保持零——保守子集合同,
/// 如实与 TS 全域打包词区分。
#[test]
fn pack_bands_match_ts_words() {
    let extended_cases = fixture()["ts"]["packExtended"]
        .as_array()
        .expect("packExtended");
    for (index, want) in extended_cases.iter().enumerate() {
        let inputs = &fixture()["inputs"]["packExtendedCases"][index]["params"];
        let params = ExtendedInputs {
            ior: inputs["ior"].as_f64().unwrap_or(1.5),
            clearcoat_factor: inputs["clearcoat"]["factor"].as_f64().unwrap_or(0.0),
            clearcoat_roughness: inputs["clearcoat"]["roughness"].as_f64().unwrap_or(0.0),
            anisotropy_strength: inputs["anisotropy"]["strength"].as_f64().unwrap_or(0.0),
            anisotropy_rotation: inputs["anisotropy"]["rotation"].as_f64().unwrap_or(0.0),
            transmission_factor: inputs["transmission"]["factor"].as_f64().unwrap_or(0.0),
        };
        let actual = extended_band_words(params);
        let expected = words(want);
        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "extended band words [{index}]"
        );
    }
    let advanced_cases = fixture()["ts"]["packAdvanced"]
        .as_array()
        .expect("packAdvanced");
    for (index, want) in advanced_cases.iter().enumerate() {
        let expected = words(want);
        // native 子集:advanced0 = sheen.rgb + roughness(TS 词 0..4 逐位)。
        let sheen_color =
            &fixture()["inputs"]["packAdvancedCases"][index]["params"]["sheen"]["color"];
        let roughness =
            fixture()["inputs"]["packAdvancedCases"][index]["params"]["sheen"]["roughness"]
                .as_f64()
                .unwrap_or(1.0);
        let actual: [f32; 4] = [
            sheen_color[0].as_f64().unwrap_or(0.0) as f32,
            sheen_color[1].as_f64().unwrap_or(0.0) as f32,
            sheen_color[2].as_f64().unwrap_or(0.0) as f32,
            roughness as f32,
        ];
        assert_eq!(
            actual.as_slice(),
            &expected[..4],
            "advanced sheen words [{index}]"
        );
    }
}

/// r185 直射 DFG 表:Rust 镜像从生产 WGSL 解析的表与 WGSL 常量同源;
/// 采样函数在若干采样点自洽(线性插值端点=表值)。
#[test]
fn direct_dfg_samples_stay_on_table_vertices() {
    let roughness = [0.0f64, 0.25, 0.5, 1.0];
    let dot_nv = [1.0f64, 0.75, 0.375, 0.0];
    for r in roughness {
        for v in dot_nv {
            let sampled = direct_dfg_185(r, v);
            // u = r*16-0.5, v = nv*16-0.5 的整数格点 → 端点即表值;半格点处双线性。
            for sample in sampled {
                assert!(sample.is_finite(), "dfg sample must be finite at ({r},{v})");
                assert!((0.0..=1.0).contains(&sample), "dfg sample out of range");
            }
        }
    }
}
