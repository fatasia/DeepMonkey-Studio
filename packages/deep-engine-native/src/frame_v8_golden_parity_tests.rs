//! B2 frame v8 双端逐字节 golden 对拍(native 侧 twin;TS 侧
//! `deep-engine/src/frameAbi/frameV8GoldenParity.test.ts`,审计差距 4,
//! ts-rust-parity-audit-20261005 §5#4 / legacy-debts-closeout-plan-20261006 B2)。
//!
//! fixture 单源双端消费:`packages/deep-engine/fixtures/frame-abi/frame-v8-golden-parity-v1.json`
//!   - 生成器(TS)写确定性输入(≥3 组)+ TS 96 字 words/sha256 + Rust 段 null 占位;
//!   - `regenerate_rust_golden_section`(--ignored 一次性)以**生产打包链**
//!     `mesh_abi::frame_uniform`(demo 轨道相机 legacy 前缀)+ `scene_lighting::DirectionalLighting::apply`
//!     (作者灯光/本地灯带)填充 Rust 596 字与 SHA-256(f32 LE 字节序);
//!   - `golden_matches_fixture` 常规门:两端摘要逐案复核 + Rust 打包位级(区分 -0)逐字对拍 +
//!     共享语义段交叉关系(schema coreFields:lightDirection xyz 全等 /
//!     sunColor rgb 全等+作者灯标记 / exposure 相等;相机三段仅布局锚,不做逐值对拍)。
//!
//! 输入适配层(不改生产打包代码):fixture `inputs.rust` 即生产 `DirectionalLighting`
//! 的 serde 字面量(direct to-light 口径 = TS `surfaceToLightWorld`,TS BRDF 与
//! native shader 同以 lightDirection.xyz 为指向光向量)+ aspect/yaw 相机入参。
use crate::frame_layout_generated::{
    FRAME_ABI_EXPOSURE_SHADOW_ENABLED, FRAME_ABI_LIGHT_DIRECTION, FRAME_ABI_RUST_FLOATS,
    FRAME_ABI_SCHEMA_SHA256, FRAME_ABI_SUN_COLOR, FRAME_ABI_TS_FLOATS,
};
use crate::mesh_abi::{frame_uniform, FRAME_UNIFORM_FLOATS};
use crate::scene_lighting::DirectionalLighting;
use crate::shader_package::hash::sha256;
use serde_json::Value;

/// fixture 路径(CARGO_MANIFEST_DIR 锚定,跨 cargo 工作目录稳定)。
const FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../deep-engine/fixtures/frame-abi/frame-v8-golden-parity-v1.json"
);
/// TS 宿主 96 字段偏移(schema tsBand;TS 侧由 generated/frameLayout.ts FRAME_ABI_CORE 钉)。
const TS_LIGHT_DIRECTION_OFFSET: usize = 76;
const TS_SUN_COLOR_OFFSET: usize = 84;
const TS_EXPOSURE_OFFSET: usize = 88;

fn f32_words(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("words array")
        .iter()
        .map(|word| word.as_f64().expect("word number") as f32)
        .collect()
}

fn f32_le_bytes(words: &[f32]) -> Vec<u8> {
    words.iter().flat_map(|word| word.to_le_bytes()).collect()
}

/// 用生产打包链构建一个 case 的 native 596 字帧(输入适配层:fixture JSON → 生产结构体)。
fn pack_native_case(case: &Value) -> Vec<f32> {
    let id = case["id"].as_str().unwrap_or("?").to_owned();
    let rust_input = &case["inputs"]["rust"];
    let aspect = rust_input["aspect"].as_f64().expect("aspect") as f32;
    let yaw = rust_input["yaw"].as_f64().expect("yaw") as f32;
    let lighting: DirectionalLighting =
        serde_json::from_value(rust_input["directionalLighting"].clone()).unwrap_or_else(|error| {
            panic!("{id}: directionalLighting must deserialize into the production struct: {error}")
        });
    lighting.validate().unwrap_or_else(|error| {
        panic!("{id}: fixture directional lighting must validate: {error}")
    });
    let mut frame = frame_uniform(aspect, yaw);
    assert_eq!(frame.len(), FRAME_UNIFORM_FLOATS / 4, "frame v8 row count");
    lighting.apply(&mut frame);
    frame.iter().flat_map(|row| row.iter().copied()).collect()
}

fn load_fixture() -> Value {
    let raw = std::fs::read_to_string(FIXTURE_PATH).expect("golden fixture readable");
    serde_json::from_str(&raw).expect("fixture parses")
}

#[test]
fn golden_matches_fixture() {
    let fixture = load_fixture();
    assert_eq!(
        fixture["fixtureSchema"],
        "deep-monkey.frame-v8-golden-parity.v1"
    );
    // schema 指纹门:fixture 与 frame-abi.schema.json 单源绑定,漂移即要求重生成。
    assert_eq!(
        fixture["frameAbiSchemaSha256"]
            .as_str()
            .expect("schema sha"),
        FRAME_ABI_SCHEMA_SHA256,
        "fixture drift vs frame-abi.schema.json: rerun generator + filler"
    );
    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= 3,
        "fixture carries at least three deterministic inputs"
    );
    for case in cases {
        let id = case["id"].as_str().expect("case id");
        let words = pack_native_case(case);
        assert_eq!(words.len(), FRAME_ABI_RUST_FLOATS, "{id} native word count");
        let ts_words = f32_words(&case["ts"]["words"]);
        assert_eq!(ts_words.len(), FRAME_ABI_TS_FLOATS, "{id} ts word count");
        // TS 段自洽(单文件双端消费:digest 是 TS 打包的逐字节钉)。
        assert_eq!(
            sha256(&f32_le_bytes(&ts_words)),
            case["ts"]["sha256"].as_str().expect("ts sha"),
            "{id} ts digest mismatch: TS packing or fixture drift, rerun the generator"
        );
        // native 打包逐字对拍 fixture rust 段(位级:区分 -0/+0,SHA-256 同口径)。
        if case["rust"]["words"].is_null() {
            panic!("{id}: rust words unfilled — run `cargo test regenerate_rust_golden_section -- --ignored`");
        }
        let expected = f32_words(&case["rust"]["words"]);
        assert_eq!(
            expected.len(),
            FRAME_ABI_RUST_FLOATS,
            "{id} fixture rust word count"
        );
        for (index, (actual, want)) in words.iter().zip(expected.iter()).enumerate() {
            assert_eq!(
                actual.to_bits(),
                want.to_bits(),
                "{id} native word {index} (row {}, col {}) drifts from golden",
                index / 4,
                index % 4
            );
        }
        assert_eq!(
            sha256(&f32_le_bytes(&words)),
            case["rust"]["sha256"].as_str().expect("rust sha"),
            "{id} native digest drifts from golden"
        );
        // 交叉关系一:lightDirection(schema coreField)两端 xyz 打包值全等
        // (适配层以 TS surfaceToLightWorld(to-light)喂 rust direction;
        // 与作者 world light 的 travel direction 相差一符号,由 fixture inputs 记录)。
        // w 双语义:ts = environmentIntensity(TS 断言),rust 恒 0(遗留闲道)。
        let light_row = FRAME_ABI_LIGHT_DIRECTION * 4;
        let ts_light = TS_LIGHT_DIRECTION_OFFSET;
        for axis in 0..3 {
            assert_eq!(
                ts_words[ts_light + axis],
                words[light_row + axis],
                "{id} lightDirection axis {axis}: both ends must pack the to-light vector"
            );
        }
        assert_eq!(
            words[light_row + 3],
            0.0,
            "{id} native lightDirection.w stays the legacy zero lane"
        );
        // 交叉关系二:sunColor rgb 全等;w 双语义 ts=作者 intensity,rust=2/3 作者灯标记。
        let sun_row = FRAME_ABI_SUN_COLOR * 4;
        for axis in 0..3 {
            assert_eq!(
                ts_words[TS_SUN_COLOR_OFFSET + axis],
                words[sun_row + axis],
                "{id} sunColor axis {axis}"
            );
        }
        let intensity = case["inputs"]["ts"]["primaryLight"]["intensity"]
            .as_f64()
            .expect("intensity") as f32;
        assert_eq!(
            ts_words[TS_SUN_COLOR_OFFSET + 3],
            intensity,
            "{id} ts sunColor.w = authored intensity"
        );
        // 作者灯标记与本地灯计数互钉:行 14 字 2 = 非 disabled 本地灯数(scene_lighting.apply),
        // w = 2(无本地灯)/ 3(有本地灯),两行必须同真同假。
        let light_count = words[FRAME_ABI_EXPOSURE_SHADOW_ENABLED * 4 + 2];
        let expected_marker = if light_count > 0.0 { 3.0 } else { 2.0 };
        assert_eq!(
            words[sun_row + 3],
            expected_marker,
            "{id} native sunColor.w marker must follow the local-light count"
        );
        // 补充观测关系:exposure(TS word 88 == native exposureShadowEnabled 行 word 0)。
        assert_eq!(
            ts_words[TS_EXPOSURE_OFFSET],
            words[FRAME_ABI_EXPOSURE_SHADOW_ENABLED * 4],
            "{id} exposure parity across ends"
        );
    }
}

/// 一次性填充:重跑后 git diff 即 native 打包行为变化(沿 TS 生成器同一纪律)。
#[test]
#[ignore = "one-shot golden filler: run after an intentional native frame packing change"]
fn regenerate_rust_golden_section() {
    let fixture = load_fixture();
    assert_eq!(
        fixture["frameAbiSchemaSha256"]
            .as_str()
            .expect("schema sha"),
        FRAME_ABI_SCHEMA_SHA256,
        "schema drift: regenerate the fixture first"
    );
    let raw = std::fs::read_to_string(FIXTURE_PATH).expect("fixture readable");
    // 本测试是"从 TS 段再生成 rust 段"的维护工具;金样已处于已填状态时无占位符可填,
    // 已填态的逐字对拍由 golden_matches_fixture 承担——如实跳过而非失败(2026-10-07)。
    if !raw.contains("\"words\": null") {
        return;
    }
    let mut updated = raw;
    for case in fixture["cases"].as_array().expect("cases array") {
        let id = case["id"].as_str().expect("case id").to_owned();
        let words = pack_native_case(case);
        let digest = sha256(&f32_le_bytes(&words));
        let numbers = words
            .iter()
            .map(|word| Value::from(*word).to_string())
            .collect::<Vec<_>>()
            .join(",");
        let replaced = updated.replacen("\"words\": null", &format!("\"words\": [{numbers}]"), 1);
        assert_ne!(
            replaced, updated,
            "{id}: no unfilled rust words placeholder left"
        );
        updated = replaced;
        let replaced =
            updated.replacen("\"sha256\": null", &format!("\"sha256\": \"{digest}\""), 1);
        assert_ne!(
            replaced, updated,
            "{id}: no unfilled rust sha256 placeholder left"
        );
        updated = replaced;
    }
    std::fs::write(FIXTURE_PATH, updated).expect("fixture writable");
    println!("filled native golden sections in {FIXTURE_PATH}");
}
