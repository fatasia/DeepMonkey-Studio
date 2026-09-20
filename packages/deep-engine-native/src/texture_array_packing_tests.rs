//! `texture_array_packing` 的单测(镜像 TS `textureArrayPacking.test.ts` 四用例)
//! 与 identityGolden 对拍(fixture 由 `packages/deep-engine/scripts/
//! generateTextureArrayGolden.mts` 生成入库;TS 侧
//! `packages/deep-engine/src/textureArrayGoldenContract.test.ts` 用同一 fixture
//! 锁 TS 行为——任一侧索引合同漂移都会使对拍失败)。

use super::*;

fn entry(id: &str, format: &str, width: u32, height: u32) -> TextureArrayPackingEntry {
    TextureArrayPackingEntry {
        texture_id: id.into(),
        format: format.into(),
        width,
        height,
    }
}

fn rgba8(id: &str) -> TextureArrayPackingEntry {
    entry(id, "rgba8unorm", 512, 512)
}

#[test]
fn bins_by_format_and_dimensions_with_lexicographic_layers() {
    let plan = plan_texture_arrays(
        &[
            entry("t-c", "rgba8unorm", 512, 512),
            entry("t-a", "rgba16float", 512, 512),
            entry("t-b", "rgba8unorm", 512, 512),
            entry("t-half", "rgba8unorm", 256, 256),
        ],
        8,
    )
    .expect("valid input");
    assert_eq!(plan.arrays.len(), 3);
    let rgba8_box = plan
        .arrays
        .iter()
        .find(|array| array.format == "rgba8unorm" && array.width == 512)
        .expect("rgba8 512 box");
    assert_eq!(rgba8_box.layers, vec!["t-b", "t-c"]); // 字典序
    let assigned = |id: &str| plan.assignments.get(id).copied().expect("assignment");
    assert_eq!(
        assigned("t-b"),
        TextureArrayAssignment {
            array_index: rgba8_box.array_index,
            layer_index: 0
        }
    );
    assert_eq!(
        assigned("t-c"),
        TextureArrayAssignment {
            array_index: rgba8_box.array_index,
            layer_index: 1
        }
    );
}

#[test]
fn overflows_beyond_max_array_layers_into_explicit_fallback_list() {
    let plan = plan_texture_arrays(&[rgba8("a"), rgba8("b"), rgba8("c")], 2).expect("valid input");
    assert_eq!(plan.overflowed, vec!["c"]);
    assert!(plan.assignments.contains_key("a"));
    assert!(plan.assignments.contains_key("b"));
    assert!(!plan.assignments.contains_key("c"));
}

#[test]
fn rejects_invalid_entries_fail_closed() {
    assert_eq!(
        plan_texture_arrays(&[entry("", "rgba8unorm", 512, 512), rgba8("ok")], 4),
        Err(TextureArrayPackingError::EmptyEntryIdentity)
    );
    assert_eq!(
        plan_texture_arrays(&[entry("bad", "rgba8unorm", 0, 8)], 4),
        Err(TextureArrayPackingError::InvalidDimensions {
            texture_id: "bad".into()
        })
    );
    assert_eq!(
        plan_texture_arrays(&[rgba8("a")], 0),
        Err(TextureArrayPackingError::InvalidMaxArrayLayers)
    );
}

#[test]
fn handles_empty_input_and_duplicate_ids_across_boxes() {
    let empty = plan_texture_arrays(&[], 4).expect("empty input");
    assert!(empty.arrays.is_empty());
    assert!(empty.overflowed.is_empty());
    let shared = plan_texture_arrays(
        &[rgba8("shared"), entry("shared", "rgba16float", 512, 512)],
        4,
    )
    .expect("valid input");
    // 同 id 不同格式进不同箱,后处理箱(rgba8unorm)覆盖先前分配(TS Map.set 语义)。
    assert_eq!(
        shared.assignments.get("shared"),
        Some(&TextureArrayAssignment {
            array_index: 1,
            layer_index: 0
        })
    );
}

#[test]
fn matches_ts_golden_fixture() {
    let path = "../deep-engine/fixtures/textureArrays/texture-array-golden.json";
    let raw = std::fs::read_to_string(path).expect("golden fixture readable");
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("fixture parses");
    assert_eq!(parsed["schema"], "deep-monkey.texture-array-golden.v1");
    let scenarios = parsed["scenarios"].as_array().expect("scenarios array");
    assert!(
        !scenarios.is_empty(),
        "fixture carries at least one scenario"
    );
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("scenario name");
        let input = &scenario["input"];
        let max_array_layers = input["maxArrayLayers"].as_u64().expect("maxArrayLayers") as u32;
        let entries: Vec<TextureArrayPackingEntry> = input["entries"]
            .as_array()
            .expect("entries array")
            .iter()
            .map(|value| TextureArrayPackingEntry {
                texture_id: value["textureId"].as_str().expect("textureId").into(),
                format: value["format"].as_str().expect("format").into(),
                width: value["width"].as_u64().expect("width") as u32,
                height: value["height"].as_u64().expect("height") as u32,
            })
            .collect();
        let built = plan_texture_arrays(&entries, max_array_layers)
            .unwrap_or_else(|error| panic!("scenario {name} must pack: {error}"));
        let expected = &scenario["plan"];

        // arrays 逐值:数量、(format,width,height,arrayIndex) 与 layers 全等。
        let expected_arrays = expected["arrays"].as_array().expect("arrays array");
        assert_eq!(
            built.arrays.len(),
            expected_arrays.len(),
            "scenario {name}: array count must match TS planTextureArrays"
        );
        for (array, want) in built.arrays.iter().zip(expected_arrays) {
            let label = format!("scenario {name} array {}", array.array_index);
            assert_eq!(
                array.format,
                want["format"].as_str().expect("format"),
                "{label}"
            );
            assert_eq!(
                array.width as u64,
                want["width"].as_u64().expect("width"),
                "{label}"
            );
            assert_eq!(
                array.height as u64,
                want["height"].as_u64().expect("height"),
                "{label}"
            );
            assert_eq!(
                array.array_index as u64,
                want["arrayIndex"].as_u64().expect("arrayIndex"),
                "{label}"
            );
            let expected_layers: Vec<&str> = want["layers"]
                .as_array()
                .expect("layers array")
                .iter()
                .map(|layer| layer.as_str().expect("layer id"))
                .collect();
            assert_eq!(array.layers, expected_layers, "{label} layers");
        }

        // assignments 逐值:条目数与每条 (arrayIndex, layerIndex) 全等。
        let expected_assignments = expected["assignments"]
            .as_array()
            .expect("assignments array");
        assert_eq!(
            built.assignments.len(),
            expected_assignments.len(),
            "scenario {name}: assignment count must match"
        );
        for want in expected_assignments {
            let texture_id = want["textureId"].as_str().expect("textureId");
            let assignment = built
                .assignments
                .get(texture_id)
                .unwrap_or_else(|| panic!("scenario {name}: missing assignment for {texture_id}"));
            assert_eq!(
                assignment.array_index as u64,
                want["arrayIndex"].as_u64().expect("arrayIndex"),
                "scenario {name}: {texture_id} arrayIndex"
            );
            assert_eq!(
                assignment.layer_index as u64,
                want["layerIndex"].as_u64().expect("layerIndex"),
                "scenario {name}: {texture_id} layerIndex"
            );
        }

        // overflowed 清单逐值全等(顺序即回退清单语义的一部分)。
        let expected_overflowed: Vec<&str> = expected["overflowed"]
            .as_array()
            .expect("overflowed array")
            .iter()
            .map(|id| id.as_str().expect("overflowed id"))
            .collect();
        assert_eq!(
            built.overflowed, expected_overflowed,
            "scenario {name}: overflow list must match"
        );
    }
}
