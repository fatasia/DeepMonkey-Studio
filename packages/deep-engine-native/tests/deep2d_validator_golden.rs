//! D01/D09 cross-language validator golden: the same fixture cases must
//! produce identical accept/reject decisions in TypeScript
//! (`validateDisplayList`) and Rust (`decode_display_list`). The TS twin of
//! this test lives at packages/deep-engine/src/deep2dGoldenContract.test.ts
//! and reads the same JSON.

use deep_engine_native::deep2d::decode_display_list;

const GOLDEN: &str = include_str!("../fixtures/deep2d_validator_golden_v1.json");

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCase {
    name: String,
    display_list: serde_json::Value,
    expected_valid: bool,
}

#[derive(serde::Deserialize)]
struct Golden {
    cases: Vec<GoldenCase>,
}

#[test]
fn rust_and_ts_validators_agree_on_every_golden_case() {
    let golden: Golden = serde_json::from_str(GOLDEN).expect("golden fixture");
    assert!(
        golden.cases.len() >= 10,
        "golden corpus must stay populated"
    );
    for case in &golden.cases {
        let serialized = serde_json::to_string(&case.display_list).expect("serialize case");
        let decision = decode_display_list(serialized.as_bytes());
        assert_eq!(
            decision.is_ok(),
            case.expected_valid,
            "case '{}' diverged: {decision:?}",
            case.name
        );
    }
}
