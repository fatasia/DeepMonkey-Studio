//! P1-22 回放器单元测试:目标模型、种子化随机、摘要与 hash 的确定性。

use super::target::{ReplayRng, ReplayTarget, SceneCell};
use super::{ReplayHost, ReplayScript, ScriptEntry, StepOutcome};
use crate::behavior_ir::{
    BehaviorPayload, BehaviorProperty, BehaviorTarget, CommandBudget, HostCapabilities, Scalar,
};
use crate::chart::simulation::parse_chart_sim_fixture;
use crate::chart::{ChartAction, ChartRuntime, parse_chart_ir};
use serde_json::json;

fn runtime() -> ChartRuntime {
    ChartRuntime::new(
        parse_chart_ir(include_bytes!(
            "../../deep-engine/fixtures/chart-ir-v1.json"
        ))
        .unwrap(),
        640.0,
        360.0,
    )
    .unwrap()
}

fn host(seed: u64) -> ReplayHost {
    let fixture = json!({
        "schema": "deep-engine.chart-sim", "schemaVersion": 1,
        "id": "replay-unit-sim", "chartId": "chart-v1-golden", "datasetId": "main",
        "dimensions": ["x", "y", "value", "name"],
        "rows": [["C", 3, 0.3, "泵三"], ["D", 4, 0.4, "水箱四"], ["E", 5, 0.5, "泵五"]],
        "seed": 1, "intervalMs": 100, "startTimeMs": 1_700_000_000_000_u64, "maxRows": 3
    });
    ReplayHost::new(
        runtime(),
        parse_chart_sim_fixture(&serde_json::to_vec(&fixture).unwrap()).unwrap(),
        CommandBudget::default(),
        HostCapabilities::default(),
        seed,
    )
    .unwrap()
}

#[test]
fn replay_rng_is_seed_deterministic_and_unit_bounded() {
    let mut a = ReplayRng::new(42);
    let mut b = ReplayRng::new(42);
    let mut sequence = Vec::new();
    for _ in 0..8 {
        let x = a.next_u64();
        let y = b.next_u64();
        assert_eq!(x, y, "same seed must replay the same sequence");
        sequence.push(x);
    }
    // unit 抽取同样消费序列:用独立实例验证值域,不与上面的对拍混步。
    let mut unit_rng = ReplayRng::new(42);
    for _ in 0..16 {
        let unit = unit_rng.next_unit();
        assert!((0.0..1.0).contains(&unit), "unit draws stay in [0, 1)");
    }
    let mut other = ReplayRng::new(43);
    assert!(
        (0..4).all(|_| other.next_u64() != sequence[0]),
        "different seeds must diverge"
    );
    // 种子 0 也是合法种子:splitmix 对任意初值都能推进。
    assert_ne!(ReplayRng::new(0).next_u64(), ReplayRng::new(0).state());
}

#[test]
fn replay_target_applies_the_closed_payload_set() {
    let mut target = ReplayTarget::default();
    target
        .apply(&BehaviorPayload::SetProperty {
            node_id: "pump".into(),
            property: BehaviorProperty::Opacity,
            value: Scalar::Number(0.5),
        })
        .unwrap();
    target
        .apply(&BehaviorPayload::SetProperty {
            node_id: "pump".into(),
            property: BehaviorProperty::Rotation,
            value: Scalar::Bool(true),
        })
        .unwrap();
    target
        .apply(&BehaviorPayload::Select {
            node_id: "pump".into(),
            additive: false,
        })
        .unwrap();
    target
        .apply(&BehaviorPayload::Select {
            node_id: "tank".into(),
            additive: true,
        })
        .unwrap();
    target
        .apply(&BehaviorPayload::Select {
            node_id: "valve".into(),
            additive: false,
        })
        .unwrap();
    target
        .apply(&BehaviorPayload::Focus {
            node_id: "pump".into(),
        })
        .unwrap();
    target
        .apply(&BehaviorPayload::RequestData {
            dataset_id: "main".into(),
            expected_source_version: Some(3),
        })
        .unwrap();
    target
        .apply(&BehaviorPayload::CancelTask {
            task_id: "fetch".into(),
        })
        .unwrap();

    let pump = target.scene()["pump"];
    assert_eq!(
        pump,
        SceneCell {
            visible: true,
            opacity: 0.5,
            rotation: 0.0,
            scale: 1.0,
            tint: 0.0,
            page: 0
        },
        "Number applies, Bool is a deterministic no-op"
    );
    // 非追加选择替换既有选择:最终只选中 valve。
    assert_eq!(
        target.selection().iter().cloned().collect::<Vec<_>>(),
        ["valve"]
    );
    assert_eq!(target.focused(), Some("pump"));
    assert_eq!(target.data_requests(), 1);
    assert_eq!(target.cancelled_tasks(), 1);

    target
        .apply(&BehaviorPayload::SetVisible {
            node_id: "pump".into(),
            visible: false,
        })
        .unwrap();
    target
        .apply(&BehaviorPayload::SetPage {
            node_id: "panel".into(),
            page: 2,
        })
        .unwrap();
    target.apply(&BehaviorPayload::ClearSelection).unwrap();
    assert!(!target.scene()["pump"].visible);
    assert_eq!(target.scene()["panel"].page, 2);
    assert!(target.selection().is_empty());
}

#[test]
fn display_hash_follows_state_and_is_stable_for_identical_states() {
    // 基线步用零抽签:产出记录但确定性地不改变任何状态。
    let baseline = ReplayScript::new(vec![ScriptEntry::Random { draws: 0 }]);
    let script = |action: Option<ChartAction>| {
        ReplayScript::new(
            std::iter::once(ScriptEntry::Random { draws: 0 })
                .chain(
                    action
                        .into_iter()
                        .map(|action| ScriptEntry::Input { action }),
                )
                .collect(),
        )
    };
    let mut untouched = host(7);
    let mut hovered = host(7);
    let untouched_trace = untouched.run(&baseline);
    let hovered_trace = hovered.run(&script(Some(ChartAction::ToggleLegend {
        series_id: "bar".into(),
    })));
    let a = &hovered_trace.steps[1];
    let b = &untouched_trace.steps[0];
    assert_eq!(a.display_hash, a.display_hash, "same state, same hash");
    assert_ne!(
        a.display_hash, b.display_hash,
        "hidden series must be visible in the digest hash"
    );
    assert_eq!(a.digest.hidden_series, vec!["bar".to_string()]);
    assert!(b.digest.hidden_series.is_empty());
    assert_eq!(
        a.digest.rng_state, b.digest.rng_state,
        "zero draws consume nothing"
    );
    // 空脚本产出空轨迹,但字节仍可比较。
    assert_eq!(untouched.run(&ReplayScript::new(vec![])).steps.len(), 0);
}

#[test]
fn idle_tick_and_over_budget_rejections_leave_the_digest_untouched() {
    let mut replay = host(7);
    // tick0 在 elapsed=0 即到期;先提交,未到期的下一次才构成 Idle 场景。
    let committed = replay.run(&ReplayScript::new(vec![ScriptEntry::SimTick {
        elapsed_ms: 0,
    }]));
    assert!(matches!(
        committed.steps[0].outcome,
        StepOutcome::Committed { tick: 0, .. }
    ));
    // 未到期(tick1 due=100):Idle,游标与数据都不动。
    let idle = replay.run(&ReplayScript::new(vec![ScriptEntry::SimTick {
        elapsed_ms: 99,
    }]));
    assert_eq!(idle.steps[0].outcome, StepOutcome::Idle);
    assert_eq!(idle.steps[0].digest.sim_committed_ticks, 1);
    assert_eq!(idle.steps[0].digest.row_count, 3);
    // 命令超时预算:1_000ms 声明撞上 100ms 上限,提交即拒。
    let mut tight = ReplayHost::new(
        runtime(),
        parse_chart_sim_fixture(
            &serde_json::to_vec(&json!({
                "schema": "deep-engine.chart-sim", "schemaVersion": 1,
                "id": "replay-unit-sim", "chartId": "chart-v1-golden", "datasetId": "main",
                "dimensions": ["x", "y", "value", "name"],
                "rows": [["C", 3, 0.3, "泵三"]],
                "seed": 1, "intervalMs": 100, "startTimeMs": 1, "maxRows": 3
            }))
            .unwrap(),
        )
        .unwrap(),
        CommandBudget {
            max_command_timeout_ms: 100,
            ..CommandBudget::default()
        },
        HostCapabilities::default(),
        7,
    )
    .unwrap();
    let rejected = tight.run(&ReplayScript::new(vec![ScriptEntry::Command {
        expected_revision: 0,
        key: "cmd-tight-timeout".into(),
        payload: BehaviorPayload::ClearSelection,
    }]));
    let StepOutcome::Rejected { reason } = &rejected.steps[0].outcome else {
        panic!("over-budget command must be rejected");
    };
    assert!(reason.contains("timeout budget exceeded"), "got: {reason}");
    assert_eq!(rejected.steps[0].digest.bus_revision, 0);
    assert_eq!(rejected.steps[0].digest.bus_in_flight, 0);
}
