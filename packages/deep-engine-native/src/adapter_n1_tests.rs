//! P1-23 N1 适配器测试:fail-closed 拒绝矩阵、预算与支持矩阵。
//! golden 输出与 replay 对拍见 `adapter_n1_golden_tests.rs`。

use super::test_support::{
    ANIMATION_FIXTURE, PLATFORM, RICH_TEXT_DIGEST, RICH_TEXT_FIXTURE, SVG_FIXTURE,
    assert_ledger_digests_match_fixtures, certification, certified_adapter, host_assets,
};
use super::{N1Adapter, N1Budget, N1Certifications, N1InputKind, N1Outcome, fixture_digest};
use crate::behavior_ir::{BehaviorPayload, BehaviorProperty, Scalar};
use serde_json::json;

#[test]
fn digest_mechanism_matches_the_ledger_constants() {
    assert_ledger_digests_match_fixtures();
}

#[test]
fn svg_subset_support_matrix_rejects_everything_outside_it() {
    use super::svg_parse::parse_svg_path_subset;
    let rejected = [
        ("M 0 0 C 1 1 2 2 3 3", "unsupported svg path command 'C'"),
        ("M 0 0 Q 1 1 2 2", "unsupported svg path command 'Q'"),
        ("M 0 0 A 1 1 0 0 1 2 2", "unsupported svg path command 'A'"),
        ("M 0 0 X 1", "unsupported svg path command 'X'"),
        ("M 0 0 1 1", "implicit coordinate repetition"),
        ("L 1 1", "subpath must start"),
        ("M 0 0 # 1", "unexpected character '#'"),
        ("M 1e400 0", "not finite"),
        ("", "no drawing commands"),
    ];
    for (data, reason) in rejected {
        let error = parse_svg_path_subset(data).expect_err(data);
        assert!(error.contains(reason), "for '{data}': {error}");
    }
    for data in ["M 0 0", "m 2 2 l 1 1 h 1 v 1 z", "M0,0L1,1z"] {
        parse_svg_path_subset(data).unwrap_or_else(|error| panic!("'{data}' must parse: {error}"));
    }
}

#[test]
fn rich_text_without_host_inline_asset_blocks_instead_of_guessing() {
    let mut assets = host_assets();
    assets.inline_assets.clear();
    let adapter = N1Adapter::new(
        N1Certifications::new([certification(N1InputKind::RichTextInline, RICH_TEXT_DIGEST)]),
        N1Budget::default(),
        assets,
    )
    .expect("host assets are valid");
    let outcome = adapter.adapt(Some(RICH_TEXT_FIXTURE.as_bytes()), PLATFORM, 0);
    let N1Outcome::Blocked { reason } = outcome else {
        panic!("missing inline asset must block");
    };
    assert!(reason.contains("no host-injected asset"), "got: {reason}");
}

#[test]
fn animation_certified_combination_samples_keyframes_at_the_injected_time() {
    let adapter = certified_adapter();
    let actions_at = |elapsed_ms: u64| -> super::N1Adapted {
        let outcome = adapter.adapt(Some(ANIMATION_FIXTURE.as_bytes()), PLATFORM, elapsed_ms);
        outcome
            .adapted()
            .expect("certified animation must adapt")
            .clone()
    };
    let at_250 = actions_at(250);
    assert_eq!(at_250.kind, N1InputKind::AnimationAbi);
    assert!(at_250.delta.commands.is_empty() && at_250.delta.resources.is_empty());
    assert_eq!(
        at_250.actions,
        vec![
            BehaviorPayload::SetProperty {
                node_id: "pump.rotor".into(),
                property: BehaviorProperty::Rotation,
                value: Scalar::Number(0.0),
            },
            BehaviorPayload::SetProperty {
                node_id: "pump.lamp".into(),
                property: BehaviorProperty::Opacity,
                value: Scalar::Index(1),
            },
        ],
        "250ms: rotor holds its first keyframe, lamp already stepped to index 1"
    );
    let at_600 = actions_at(600);
    assert_eq!(
        at_600.actions,
        vec![
            BehaviorPayload::SetProperty {
                node_id: "pump.rotor".into(),
                property: BehaviorProperty::Rotation,
                value: Scalar::Number(90.0),
            },
            BehaviorPayload::SetProperty {
                node_id: "pump.lamp".into(),
                property: BehaviorProperty::Opacity,
                value: Scalar::Index(2),
            },
        ]
    );
    // 注入时刻是纯函数:同一时刻双采样逐字节一致。
    assert_eq!(actions_at(250), at_250);
}

#[test]
fn fail_closed_matrix_blocks_and_unknowns_carry_reasons() {
    let adapter = certified_adapter();
    let reason_of = |outcome: N1Outcome| match outcome {
        N1Outcome::Adapted(_) => panic!("must not adapt"),
        N1Outcome::Unknown { reason } | N1Outcome::Blocked { reason } => reason,
    };
    // 缺失 fixture(None / 空字节)。
    let reason = reason_of(adapter.adapt(None, PLATFORM, 0));
    assert!(reason.contains("missing fixture"), "got: {reason}");
    let reason = reason_of(adapter.adapt(Some(b"".as_slice()), PLATFORM, 0));
    assert!(reason.contains("missing fixture"), "got: {reason}");
    // 非法 JSON。
    let reason = reason_of(adapter.adapt(Some(b"{oops".as_slice()), PLATFORM, 0));
    assert!(reason.contains("not valid JSON"), "got: {reason}");
    // 未知 kind / 缺判别字段 → Unknown。
    let unknown_kind = json!({"kind":"lottie","schemaVersion":1,"input":{}}).to_string();
    let N1Outcome::Unknown { reason } = adapter.adapt(Some(unknown_kind.as_bytes()), PLATFORM, 0)
    else {
        panic!("unknown kind must be Unknown");
    };
    assert!(
        reason.contains("unknown input kind 'lottie'"),
        "got: {reason}"
    );
    let no_discriminator = json!({"schemaVersion":1}).to_string();
    let N1Outcome::Unknown { reason } =
        adapter.adapt(Some(no_discriminator.as_bytes()), PLATFORM, 0)
    else {
        panic!("missing kind must be Unknown");
    };
    assert!(reason.contains("no 'kind' discriminator"), "got: {reason}");
    // 未知版本 → Unknown(认证台账无关,分类先于认证查询)。
    let unknown_version =
        json!({"kind":"svg","schemaVersion":2,"input":{"id":"x","viewBox":[0,0,1,1],"paths":[]}})
            .to_string();
    let N1Outcome::Unknown { reason } =
        adapter.adapt(Some(unknown_version.as_bytes()), PLATFORM, 0)
    else {
        panic!("unknown version must be Unknown");
    };
    assert!(
        reason.contains("unsupported schema version 2 for kind 'svg'"),
        "got: {reason}"
    );
    // 载荷不符声明 schema / 缺载荷 → Blocked(摘要先行匹配,防御性复核仍拦)。
    let nonconforming =
        json!({"kind":"svg","schemaVersion":1,"input":{"id":"x","extra":true}}).to_string();
    let digest = fixture_digest(nonconforming.as_bytes()).expect("valid json");
    let malformed_certified = N1Adapter::new(
        N1Certifications::new([certification(N1InputKind::Svg, &digest)]),
        N1Budget::default(),
        host_assets(),
    )
    .expect("host assets are valid");
    let reason = reason_of(malformed_certified.adapt(Some(nonconforming.as_bytes()), PLATFORM, 0));
    assert!(
        reason.contains("does not conform to its declared schema"),
        "got: {reason}"
    );
    let empty_payload = json!({"kind":"svg","schemaVersion":1}).to_string();
    let digest = fixture_digest(empty_payload.as_bytes()).expect("valid json");
    let malformed_certified = N1Adapter::new(
        N1Certifications::new([certification(N1InputKind::Svg, &digest)]),
        N1Budget::default(),
        host_assets(),
    )
    .expect("host assets are valid");
    let reason = reason_of(malformed_certified.adapt(Some(empty_payload.as_bytes()), PLATFORM, 0));
    assert!(reason.contains("no 'input' payload"), "got: {reason}");
    // 未认证平台组合 → Blocked。
    let reason = reason_of(adapter.adapt(Some(SVG_FIXTURE.as_bytes()), "mac-metal", 0));
    assert!(reason.contains("is not certified"), "got: {reason}");
    // 摘要不匹配(内容被替换)→ Blocked。
    let tampered = certified_adapter_with_digest(&"0".repeat(64));
    let reason = reason_of(tampered.adapt(Some(SVG_FIXTURE.as_bytes()), PLATFORM, 0));
    assert!(reason.contains("digest mismatch"), "got: {reason}");
}

fn certified_adapter_with_digest(digest: &str) -> N1Adapter {
    N1Adapter::new(
        N1Certifications::new([certification(N1InputKind::Svg, digest)]),
        N1Budget::default(),
        host_assets(),
    )
    .expect("host assets are valid")
}

#[test]
fn duplicate_resource_ids_block_before_merge() {
    // 重复资源 id 会让 delta 无法并入同一 display list:SVG 与图表扩展
    // 都在适配层即拒绝(摘要先行匹配,与拒载分层可辨)。
    let duplicate_svg = json!({"kind":"svg","schemaVersion":1,"input":{"id":"n1.svg.dup","viewBox":[0,0,10,10],"paths":[
        {"id":"n1.svg.dup.a","data":"M 0 0 L 1 1","zOrder":0,"stroke":[1,1,1,1],"strokeWidth":1},
        {"id":"n1.svg.dup.a","data":"M 1 1 L 2 2","zOrder":0,"stroke":[1,1,1,1],"strokeWidth":1}]}})
        .to_string();
    let digest = fixture_digest(duplicate_svg.as_bytes()).expect("valid json");
    let N1Outcome::Blocked { reason } =
        certified_adapter_with_digest(&digest).adapt(Some(duplicate_svg.as_bytes()), PLATFORM, 0)
    else {
        panic!("duplicate svg path id must block");
    };
    assert!(reason.contains("duplicate svg path id"), "got: {reason}");

    let duplicate_chart = json!({"kind":"chart-extension","schemaVersion":1,"input":{"id":"n1.chart.dup","overlays":[
        {"overlay":"marker","id":"n1.chart.dup.m","center":[1,1],"radius":1,"fill":[0,0,0,1],"zOrder":0},
        {"overlay":"marker","id":"n1.chart.dup.m","center":[2,2],"radius":1,"fill":[0,0,0,1],"zOrder":0}]}})
        .to_string();
    let digest = fixture_digest(duplicate_chart.as_bytes()).expect("valid json");
    let adapter = N1Adapter::new(
        N1Certifications::new([certification(N1InputKind::ChartExtension, &digest)]),
        N1Budget::default(),
        host_assets(),
    )
    .expect("host assets are valid");
    let N1Outcome::Blocked { reason } =
        adapter.adapt(Some(duplicate_chart.as_bytes()), PLATFORM, 0)
    else {
        panic!("duplicate chart overlay id must block");
    };
    assert!(
        reason.contains("duplicate chart overlay id"),
        "got: {reason}"
    );
}

#[test]
fn budget_exceeded_blocks_instead_of_truncating() {
    // fixture 字节预算:内容不变、摘要匹配,只有预算触界,故拦截点可辨。
    let adapter = N1Adapter::new(
        N1Certifications::new([certification(
            N1InputKind::Svg,
            super::test_support::SVG_DIGEST,
        )]),
        N1Budget {
            max_paths: 1,
            max_fixture_bytes: 4 * 1024 * 1024,
            ..N1Budget::default()
        },
        host_assets(),
    )
    .expect("host assets are valid");
    let N1Outcome::Blocked { reason } = adapter.adapt(Some(SVG_FIXTURE.as_bytes()), PLATFORM, 0)
    else {
        panic!("over-budget input must block");
    };
    assert!(
        reason.contains("svg path budget exceeded: 2 paths > max 1"),
        "got: {reason}"
    );
    let bytes_budget = N1Budget {
        max_fixture_bytes: 16,
        ..N1Budget::default()
    };
    let adapter = N1Adapter::new(
        N1Certifications::new([certification(
            N1InputKind::Svg,
            super::test_support::SVG_DIGEST,
        )]),
        bytes_budget,
        host_assets(),
    )
    .expect("host assets are valid");
    let N1Outcome::Blocked { reason } = adapter.adapt(Some(SVG_FIXTURE.as_bytes()), PLATFORM, 0)
    else {
        panic!("over-budget fixture must block");
    };
    assert!(reason.contains("byte budget"), "got: {reason}");
}

#[test]
fn rich_text_budget_counts_utf16_code_units() {
    let fixture = json!({
        "kind": "rich-text-inline",
        "schemaVersion": 1,
        "input": {
            "id": "n1.rt.utf16",
            "text": "😀",
            "styles": [],
            "paragraphs": [],
            "inlineObjects": []
        }
    })
    .to_string();
    let digest = fixture_digest(fixture.as_bytes()).expect("valid json");
    let adapter = N1Adapter::new(
        N1Certifications::new([certification(N1InputKind::RichTextInline, &digest)]),
        N1Budget {
            max_text_code_units: 1,
            ..N1Budget::default()
        },
        host_assets(),
    )
    .expect("host assets are valid");

    let N1Outcome::Blocked { reason } = adapter.adapt(Some(fixture.as_bytes()), PLATFORM, 0) else {
        panic!("one astral character must consume two UTF-16 code units");
    };
    assert!(
        reason.contains("rich text code-unit budget exceeded: 2 > max 1"),
        "got: {reason}"
    );
}
