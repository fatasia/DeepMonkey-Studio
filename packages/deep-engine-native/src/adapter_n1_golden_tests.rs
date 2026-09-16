//! P1-23 N1 适配器 golden 对拍:三类 display delta 的期望输出、
//! 与 TS 共享合同的交叉校验,以及 P1-22 回放双跑一致性。

use super::test_support::{
    ANIMATION_FIXTURE, CHART_FIXTURE, PLATFORM, RICH_TEXT_FIXTURE, SVG_FIXTURE, certified_adapter,
};
use super::{N1DisplayDelta, N1InputKind, N1Outcome};
use crate::behavior_ir::{CommandBudget, HostCapabilities};
use crate::chart::simulation::parse_chart_sim_fixture;
use crate::chart::{ChartRuntime, parse_chart_ir};
use crate::deep2d::{Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, validate_display_list};
use crate::replay::{ReplayHost, ReplayScript, ScriptEntry, StepOutcome};
use serde_json::json;

/// path 命令的全部有效载荷字段(用于 golden 对拍)。
#[derive(Debug, PartialEq)]
struct PathView<'a> {
    id: &'a str,
    z_order: i32,
    path_id: &'a str,
    fill: Option<[f64; 4]>,
    stroke: Option<[f64; 4]>,
    stroke_width: Option<f64>,
}

fn path_view(command: &Deep2dCommand) -> PathView<'_> {
    let Deep2dCommand::Path(path) = command else {
        panic!("expected a path command");
    };
    PathView {
        id: path.id.as_str(),
        z_order: path.z_order,
        path_id: path.path_id.as_str(),
        fill: path.fill,
        stroke: path.stroke,
        stroke_width: path.stroke_width,
    }
}

fn path_verbs(delta: &N1DisplayDelta, index: usize) -> &Vec<Deep2dPathVerb> {
    let crate::deep2d::Deep2dResource::Path(path) = &delta.resources[index] else {
        panic!("expected a path resource");
    };
    &path.verbs
}

/// 把 delta 并入一个最小合法 display list,验证其满足 TS 共享合同。
fn validates_against_deep2d_contract(delta: &N1DisplayDelta) -> Result<(), String> {
    let display_list = Deep2dDisplayList {
        schema_version: 1,
        id: "n1.golden.wrap".into(),
        revision: 0,
        logical_width: 800.0,
        logical_height: 600.0,
        scale_factor: 1.0,
        resources: delta.resources.clone(),
        commands: delta.commands.clone(),
        atlases: Vec::new(),
    };
    let result = validate_display_list(&display_list);
    if result.valid {
        Ok(())
    } else {
        Err(format!("{:?}", result.issues))
    }
}

#[test]
fn svg_certified_combination_produces_the_golden_delta() {
    let outcome = certified_adapter().adapt(Some(SVG_FIXTURE.as_bytes()), PLATFORM, 0);
    let adapted = outcome.adapted().expect("certified svg must adapt");
    assert_eq!(adapted.kind, N1InputKind::Svg);
    assert!(
        adapted.actions.is_empty(),
        "svg carries no behavior commands"
    );
    assert_eq!(adapted.delta.schema_version, 1);

    // 资源 golden:动词序列逐字相等(含相对指令的解析结果)。
    assert_eq!(adapted.delta.resources.len(), 2);
    assert_eq!(
        path_verbs(&adapted.delta, 0),
        &[
            Deep2dPathVerb::Move { x: 2.0, y: 12.0 },
            Deep2dPathVerb::Line { x: 12.0, y: 2.0 },
            Deep2dPathVerb::Line { x: 22.0, y: 12.0 },
            Deep2dPathVerb::Line { x: 12.0, y: 22.0 },
            Deep2dPathVerb::Close,
        ]
    );
    assert_eq!(
        path_verbs(&adapted.delta, 1),
        &[
            Deep2dPathVerb::Move { x: 12.0, y: 22.0 },
            Deep2dPathVerb::Line { x: 12.0, y: 16.0 },
            Deep2dPathVerb::Line { x: 16.0, y: 16.0 },
        ]
    );

    // 命令 golden:payload 字段逐项对拍。
    assert_eq!(adapted.delta.commands.len(), 2);
    assert_eq!(
        path_view(&adapted.delta.commands[0]),
        PathView {
            id: "n1.svg.icon.body.paint",
            z_order: 1,
            path_id: "n1.svg.icon.body",
            fill: Some([0.1, 0.2, 0.3, 1.0]),
            stroke: Some([1.0, 1.0, 1.0, 1.0]),
            stroke_width: Some(1.5),
        }
    );
    assert_eq!(
        path_view(&adapted.delta.commands[1]),
        PathView {
            id: "n1.svg.icon.stem.paint",
            z_order: 2,
            path_id: "n1.svg.icon.stem",
            fill: None,
            stroke: Some([1.0, 0.0, 0.0, 1.0]),
            stroke_width: Some(1.0),
        }
    );
    validates_against_deep2d_contract(&adapted.delta)
        .expect("svg delta must satisfy the shared deep2d contract");
}

#[test]
fn rich_text_certified_combination_produces_the_golden_delta() {
    let outcome = certified_adapter().adapt(Some(RICH_TEXT_FIXTURE.as_bytes()), PLATFORM, 0);
    let adapted = outcome.adapted().expect("certified rich text must adapt");
    assert_eq!(adapted.kind, N1InputKind::RichTextInline);
    // 字体资源由宿主身份注入;图片资源来自 inline object 的宿主映射。
    assert_eq!(adapted.delta.resources.len(), 2);
    let crate::deep2d::Deep2dResource::Font(font) = &adapted.delta.resources[0] else {
        panic!("expected a font resource");
    };
    assert_eq!(
        (font.id.as_str(), font.family.as_str(), font.weight),
        ("n1.font.main", "Inter", 400)
    );
    let crate::deep2d::Deep2dResource::Image(image) = &adapted.delta.resources[1] else {
        panic!("expected an image resource");
    };
    assert_eq!(
        (
            image.id.as_str(),
            image.asset_id.as_str(),
            image.width,
            image.height
        ),
        ("n1.rt.pump.icon", "asset.pump-icon", 16, 16)
    );
    // 段落文本按簇区间切片:"泵运行 "(0..4)与 "abnormal"(4..12)。
    assert_eq!(adapted.delta.commands.len(), 3);
    let text_of = |index: usize| -> &str {
        let Deep2dCommand::Text(text) = &adapted.delta.commands[index] else {
            panic!("expected a text command");
        };
        &text.text
    };
    assert_eq!(text_of(0), "泵运行 ");
    assert_eq!(text_of(1), "abnormal");
    let Deep2dCommand::Text(head) = &adapted.delta.commands[0] else {
        panic!("expected a text command");
    };
    assert_eq!(
        (
            head.id.as_str(),
            head.font_id.as_str(),
            head.font_size,
            head.color
        ),
        (
            "n1.rt.panel.text.0",
            "n1.font.main",
            14.0,
            [0.05, 0.05, 0.05, 1.0]
        )
    );
    let Deep2dCommand::Image(inline) = &adapted.delta.commands[2] else {
        panic!("expected an image command");
    };
    assert_eq!(
        (
            inline.id.as_str(),
            inline.image_id.as_str(),
            inline.hit_id.as_deref()
        ),
        (
            "n1.rt.panel.inline.2",
            "n1.rt.pump.icon",
            Some("n1.rt.pump.icon")
        )
    );
    validates_against_deep2d_contract(&adapted.delta)
        .expect("rich text delta must satisfy the shared deep2d contract");
}

#[test]
fn chart_extension_certified_combination_produces_the_golden_delta() {
    let outcome = certified_adapter().adapt(Some(CHART_FIXTURE.as_bytes()), PLATFORM, 0);
    let adapted = outcome
        .adapted()
        .expect("certified chart extension must adapt");
    assert_eq!(adapted.kind, N1InputKind::ChartExtension);
    assert_eq!(adapted.delta.resources.len(), 3);
    assert_eq!(adapted.delta.commands.len(), 3);
    // 趋势线 = M + L;阈值带 = 矩形闭合;标记点 = 四段贝塞尔圆。
    assert_eq!(
        path_verbs(&adapted.delta, 0),
        &[
            Deep2dPathVerb::Move { x: 0.0, y: 10.0 },
            Deep2dPathVerb::Line { x: 100.0, y: 20.0 },
        ]
    );
    assert_eq!(
        path_verbs(&adapted.delta, 1),
        &[
            Deep2dPathVerb::Move { x: 0.0, y: 8.0 },
            Deep2dPathVerb::Line { x: 100.0, y: 8.0 },
            Deep2dPathVerb::Line { x: 100.0, y: 12.0 },
            Deep2dPathVerb::Line { x: 0.0, y: 12.0 },
            Deep2dPathVerb::Close,
        ]
    );
    assert_eq!(
        path_verbs(&adapted.delta, 2).len(),
        6,
        "circle = move + 4 cubics + close"
    );
    assert_eq!(
        path_verbs(&adapted.delta, 2)[0],
        Deep2dPathVerb::Move { x: 54.0, y: 15.0 }
    );
    assert_eq!(path_verbs(&adapted.delta, 2)[5], Deep2dPathVerb::Close);
    assert_eq!(
        path_view(&adapted.delta.commands[0]),
        PathView {
            id: "n1.chart.trend.paint",
            z_order: 5,
            path_id: "n1.chart.trend",
            fill: None,
            stroke: Some([0.0, 0.5, 1.0, 1.0]),
            stroke_width: Some(2.0),
        }
    );
    assert_eq!(
        path_view(&adapted.delta.commands[1]),
        PathView {
            id: "n1.chart.band.paint",
            z_order: 1,
            path_id: "n1.chart.band",
            fill: Some([1.0, 0.0, 0.0, 0.25]),
            stroke: None,
            stroke_width: None,
        }
    );
    validates_against_deep2d_contract(&adapted.delta)
        .expect("chart extension delta must satisfy the shared deep2d contract");
}

#[test]
fn adapter_actions_replay_twice_with_byte_identical_traces() {
    // P1-22 呼应:适配产物中的行为命令直接编入回放脚本。
    let outcome = certified_adapter().adapt(Some(ANIMATION_FIXTURE.as_bytes()), PLATFORM, 250);
    let N1Outcome::Adapted(adapted) = outcome else {
        panic!("certified animation must adapt");
    };
    let actions = adapted.actions;
    assert_eq!(actions.len(), 2);
    let script = ReplayScript::new(
        actions
            .into_iter()
            .enumerate()
            .map(|(index, payload)| ScriptEntry::Command {
                expected_revision: index as u64,
                key: format!("n1-anim-key-{index:02}"),
                payload,
            })
            .collect(),
    );
    let build_host = || {
        let sim_fixture = json!({
            "schema": "deep-engine.chart-sim", "schemaVersion": 1,
            "id": "adapter-n1-sim", "chartId": "chart-v1-golden", "datasetId": "main",
            "dimensions": ["x", "y", "value", "name"],
            "rows": [["C", 3, 0.3, "泵三"]],
            "seed": 1, "intervalMs": 100, "startTimeMs": 1, "maxRows": 3
        });
        ReplayHost::new(
            ChartRuntime::new(
                parse_chart_ir(include_bytes!(
                    "../../deep-engine/fixtures/chart-ir-v1.json"
                ))
                .expect("bundled chart fixture"),
                640.0,
                360.0,
            )
            .expect("chart runtime"),
            parse_chart_sim_fixture(&serde_json::to_vec(&sim_fixture).expect("sim json"))
                .expect("sim fixture"),
            CommandBudget::default(),
            HostCapabilities::default(),
            7,
        )
        .expect("replay host")
    };
    let mut first = build_host();
    let mut second = build_host();
    let trace_a = first.run(&script);
    let trace_b = second.run(&script);
    assert_eq!(trace_a.steps.len(), 2);
    // 双跑一致:整条轨迹(含 outcomes、digest、display hash)逐字节相等。
    assert_eq!(trace_a, trace_b, "double run must be byte-identical");
    assert_eq!(
        trace_a.wire_bytes(),
        trace_b.wire_bytes(),
        "serialized traces must be byte-identical"
    );
    for step in &trace_a.steps {
        assert!(
            matches!(step.outcome, StepOutcome::Settled { .. }),
            "every adapter command must settle: {:?}",
            step.outcome
        );
    }
    // 采样值真实落到回放目标场景(rotor 保持 0,lamp 步进到 1)。
    let scene = &trace_a.steps[1].digest.target.scene;
    assert_eq!(scene["pump.rotor"].rotation, 0.0);
    assert_eq!(scene["pump.lamp"].opacity, 1.0);
}
