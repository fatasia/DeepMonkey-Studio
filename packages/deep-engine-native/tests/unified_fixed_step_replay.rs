//! P1-22 统一固定步回放:双跑逐字节一致、过期命令拒绝、取消终态与预算边界。
//! 全部固定时钟,无真实等待、无真实 IO。

use deep_engine_native::behavior_ir::{BehaviorPayload, CommandBudget, HostCapabilities};
use deep_engine_native::chart::simulation::parse_chart_sim_fixture;
use deep_engine_native::chart::{ChartAction, ChartRuntime, parse_chart_ir};
use deep_engine_native::replay::{ReplayHost, ReplayScript, ScriptEntry, StepOutcome};
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
    host_with_budget(seed, CommandBudget::default())
}

fn host_with_budget(seed: u64, budget: CommandBudget) -> ReplayHost {
    let fixture = json!({
        "schema": "deep-engine.chart-sim", "schemaVersion": 1,
        "id": "unified-replay-sim", "chartId": "chart-v1-golden", "datasetId": "main",
        "dimensions": ["x", "y", "value", "name"],
        "rows": [["C", 3, 0.3, "泵三"], ["D", 4, 0.4, "水箱四"], ["E", 5, 0.5, "泵五"]],
        "seed": 1, "intervalMs": 100, "startTimeMs": 1_700_000_000_000_u64, "maxRows": 3
    });
    ReplayHost::new(
        runtime(),
        parse_chart_sim_fixture(&serde_json::to_vec(&fixture).unwrap()).unwrap(),
        budget,
        HostCapabilities::default(),
        seed,
    )
    .unwrap()
}

/// 混合脚本:sim tick + 命令(立即/延迟/过期)+ 输入事件 + 种子化随机 + 取消尾部。
fn mixed_script() -> ReplayScript {
    ReplayScript::new(vec![
        ScriptEntry::Random { draws: 3 },
        ScriptEntry::SimTick { elapsed_ms: 0 },
        ScriptEntry::Command {
            expected_revision: 0,
            key: "cmd-select-line-0001".into(),
            payload: BehaviorPayload::Select {
                node_id: "line".into(),
                additive: false,
            },
        },
        ScriptEntry::Input {
            action: ChartAction::Highlight {
                series_id: "line".into(),
                data_index: Some(1),
            },
        },
        ScriptEntry::Input {
            action: ChartAction::ToggleLegend {
                series_id: "bar".into(),
            },
        },
        ScriptEntry::Stage {
            slot: 0,
            expected_revision: 1,
            key: "cmd-stage-visibility".into(),
            payload: BehaviorPayload::SetVisible {
                node_id: "pump-a".into(),
                visible: false,
            },
        },
        ScriptEntry::Command {
            expected_revision: 1,
            key: "cmd-page-two-000001".into(),
            payload: BehaviorPayload::SetPage {
                node_id: "panel".into(),
                page: 2,
            },
        },
        ScriptEntry::SimTick { elapsed_ms: 100 },
        ScriptEntry::Settle { slot: 0 },
        ScriptEntry::Command {
            expected_revision: 0,
            key: "cmd-stale-revision0".into(),
            payload: BehaviorPayload::SetVisible {
                node_id: "ghost".into(),
                visible: true,
            },
        },
        ScriptEntry::Random { draws: 2 },
        ScriptEntry::Input {
            action: ChartAction::Zoom {
                axis_id: "x".into(),
                start: 0.0,
                end: 0.5,
            },
        },
        ScriptEntry::CancelSim,
        ScriptEntry::SimTick { elapsed_ms: 200 },
        ScriptEntry::CancelSim,
    ])
}

#[test]
fn mixed_script_replays_byte_identical_twice() {
    let mut first = host(42);
    let mut second = host(42);
    let trace_a = first.run(&mixed_script());
    let trace_b = second.run(&mixed_script());
    assert_eq!(
        trace_a, trace_b,
        "same script and seed must replay identically"
    );
    assert_eq!(trace_a.wire_bytes(), trace_b.wire_bytes());

    // 命令序列与状态轨迹逐条核对(15 步)。
    let steps = &trace_a.steps;
    assert_eq!(steps.len(), 15);
    assert!(matches!(&steps[0].outcome, StepOutcome::Drawn { values } if values.len() == 3));
    assert!(matches!(
        &steps[1].outcome,
        StepOutcome::Committed { tick: 0, .. }
    ));
    // fixture seed=1、rows=[C,D,E]:tick0 取 rows[(1+0)%3] = D。
    assert_eq!(
        steps[1].digest.last_row,
        Some(vec![json!("D"), json!(4), json!(0.4), json!("水箱四")])
    );
    assert!(matches!(
        &steps[2].outcome,
        StepOutcome::Settled { revision: 1 }
    ));
    assert_eq!(steps[2].digest.target.selection, vec!["line".to_string()]);
    assert!(matches!(
        &steps[5].outcome,
        StepOutcome::Staged { invocation: 2 }
    ));
    assert!(matches!(
        &steps[6].outcome,
        StepOutcome::Settled { revision: 2 }
    ));
    assert!(matches!(
        &steps[7].outcome,
        StepOutcome::Committed { tick: 1, .. }
    ));
    let StepOutcome::Rejected { reason } = &steps[8].outcome else {
        panic!("deferred settle after revision moved must be rejected");
    };
    assert!(reason.contains("revision moved"), "got: {reason}");
    // 拒绝步不推进任何状态:摘要与上一步逐字段一致,display hash 相同。
    assert_eq!(steps[8].digest, steps[7].digest);
    assert_eq!(steps[8].display_hash, steps[7].display_hash);
    assert_eq!(steps[8].digest.bus_in_flight, 1, "command stays in flight");
    assert!(
        matches!(&steps[9].outcome, StepOutcome::Rejected { reason } if reason.contains("stale revision (expected 0, current 2)"))
    );
    assert_eq!(
        steps[9].digest, steps[8].digest,
        "stale command changed nothing"
    );
    assert!(!steps[9].digest.target.scene.contains_key("ghost"));
    assert!(matches!(
        &steps[11].outcome,
        StepOutcome::Applied { changed: true }
    ));
    assert_eq!(steps[11].digest.zoom_windows, vec![("x".into(), 0.0, 0.5)]);
    assert!(matches!(steps[12].outcome, StepOutcome::Cancelled));
    let StepOutcome::NoOutput = steps[13].outcome else {
        panic!("sim tick after cancellation must not produce output");
    };
    assert_eq!(
        steps[13].digest.sim_committed_ticks, 2,
        "cursor never moves"
    );
    assert_eq!(
        steps[13].digest.row_count, 3,
        "window keeps tick0+tick1 rows"
    );
    assert!(steps[13].digest.sim_cancelled);
    assert_eq!(steps[13].digest.sim_due_ms, None);
    assert!(matches!(steps[14].outcome, StepOutcome::Cancelled));
}

#[test]
fn stale_command_rejection_leaves_revision_trace_and_target_untouched() {
    let script = ReplayScript::new(vec![
        ScriptEntry::Command {
            expected_revision: 0,
            key: "cmd-apply-first-0001".into(),
            payload: BehaviorPayload::SetVisible {
                node_id: "pump-a".into(),
                visible: false,
            },
        },
        ScriptEntry::Command {
            expected_revision: 0,
            key: "cmd-stale-against-1".into(),
            payload: BehaviorPayload::SetVisible {
                node_id: "ghost".into(),
                visible: true,
            },
        },
    ]);
    let mut replay = host(9);
    let trace = replay.run(&script);
    assert!(matches!(
        &trace.steps[0].outcome,
        StepOutcome::Settled { revision: 1 }
    ));
    let StepOutcome::Rejected { reason } = &trace.steps[1].outcome else {
        panic!("stale command must be rejected at submit");
    };
    assert!(
        reason.contains("stale revision (expected 0, current 1)"),
        "got: {reason}"
    );
    assert_eq!(
        trace.steps[1].digest.bus_revision, 1,
        "revision never advances"
    );
    assert_eq!(
        trace.steps[1].digest.bus_in_flight, 0,
        "rejected command is not staged"
    );
    assert!(!trace.steps[1].digest.target.scene.contains_key("ghost"));
    assert_eq!(trace.steps[1].display_hash, trace.steps[0].display_hash);
    // 双跑一致同样覆盖拒绝路径。
    let mut again = host(9);
    assert_eq!(trace, again.run(&script));
}

#[test]
fn deferred_settle_never_applies_a_superseded_command() {
    let script = ReplayScript::new(vec![
        ScriptEntry::Stage {
            slot: 0,
            expected_revision: 0,
            key: "cmd-deferred-visible".into(),
            payload: BehaviorPayload::SetVisible {
                node_id: "pump-a".into(),
                visible: false,
            },
        },
        ScriptEntry::Command {
            expected_revision: 0,
            key: "cmd-advance-first-1".into(),
            payload: BehaviorPayload::SetPage {
                node_id: "panel".into(),
                page: 2,
            },
        },
        ScriptEntry::Settle { slot: 0 },
        ScriptEntry::Settle { slot: 0 },
    ]);
    let mut replay = host(5);
    let trace = replay.run(&script);
    let StepOutcome::Rejected { reason } = &trace.steps[2].outcome else {
        panic!("superseded settle must be rejected");
    };
    assert!(reason.contains("revision moved while in flight (expected 0, current 1)"));
    assert!(
        trace.steps[2]
            .digest
            .target
            .scene
            .get("pump-a")
            .is_none_or(|cell| cell.visible),
        "superseded payload must never be applied"
    );
    // 重试仍失败:revision 只进不退,过期命令永久失效;slot 记录保持可审计。
    assert!(matches!(
        &trace.steps[3].outcome,
        StepOutcome::Rejected { .. }
    ));
    assert_eq!(trace.steps[3].digest, trace.steps[2].digest);
}

#[test]
fn cancelled_sim_tail_produces_no_output_and_repeat_cancel_is_idempotent() {
    let script = ReplayScript::new(vec![
        ScriptEntry::SimTick { elapsed_ms: 0 },
        ScriptEntry::CancelSim,
        ScriptEntry::SimTick { elapsed_ms: 50 },
        ScriptEntry::SimTick { elapsed_ms: 100 },
        ScriptEntry::CancelSim,
    ]);
    let mut replay = host(11);
    let trace = replay.run(&script);
    assert!(matches!(
        &trace.steps[0].outcome,
        StepOutcome::Committed { tick: 0, .. }
    ));
    assert!(matches!(trace.steps[1].outcome, StepOutcome::Cancelled));
    for step in &trace.steps[2..4] {
        assert!(
            matches!(step.outcome, StepOutcome::NoOutput),
            "got {:?}",
            step.outcome
        );
        assert_eq!(step.digest.sim_committed_ticks, 1, "tail never produces");
        assert!(step.digest.sim_cancelled);
        assert_eq!(step.digest.sim_due_ms, None);
    }
    // 尾部各步除注入时钟外逐字段一致:时钟在走,状态冻结。
    let mut frozen = trace.steps[2].digest.clone();
    frozen.now_ms = trace.steps[3].digest.now_ms;
    assert_eq!(
        frozen, trace.steps[3].digest,
        "only the injected clock may move"
    );
    assert!(matches!(trace.steps[4].outcome, StepOutcome::Cancelled));
}

#[test]
fn empty_script_and_zero_draws_are_well_formed_boundaries() {
    let mut replay = host(3);
    let empty = replay.run(&ReplayScript::new(vec![]));
    assert_eq!(empty.steps.len(), 0);
    assert_eq!(empty.wire_bytes(), b"{\"steps\":[]}".to_vec());

    let zeros = replay.run(&ReplayScript::new(vec![
        ScriptEntry::Random { draws: 0 },
        ScriptEntry::Random { draws: 0 },
    ]));
    assert!(matches!(&zeros.steps[0].outcome, StepOutcome::Drawn { values } if values.is_empty()));
    assert_eq!(
        zeros.steps[0].digest.rng_state, zeros.steps[1].digest.rng_state,
        "zero draws never consume the seed"
    );
    // 抽签数封顶:脚本炸弹被预算拒绝,状态不动。
    let bomb = replay.run(&ReplayScript::new(vec![ScriptEntry::Random {
        draws: u32::MAX,
    }]));
    let StepOutcome::Rejected { reason } = &bomb.steps[0].outcome else {
        panic!("unbounded draws must be rejected");
    };
    assert!(reason.contains("exceed the per-step budget"));
}

#[test]
fn over_budget_commands_are_rejected_by_the_command_budget() {
    // 在途上限 1:第二条 stage 与紧随的命令都被拒,槽位0命令保持唯一在途。
    let budget = CommandBudget {
        max_in_flight: 1,
        ..CommandBudget::default()
    };
    let script = ReplayScript::new(vec![
        ScriptEntry::Stage {
            slot: 0,
            expected_revision: 0,
            key: "cmd-stage-first-0001".into(),
            payload: BehaviorPayload::ClearSelection,
        },
        ScriptEntry::Stage {
            slot: 1,
            expected_revision: 0,
            key: "cmd-stage-second-0002".into(),
            payload: BehaviorPayload::ClearSelection,
        },
        ScriptEntry::Command {
            expected_revision: 0,
            key: "cmd-while-capped-03".into(),
            payload: BehaviorPayload::ClearSelection,
        },
    ]);
    let mut replay = host_with_budget(13, budget);
    let trace = replay.run(&script);
    assert!(matches!(
        &trace.steps[0].outcome,
        StepOutcome::Staged { invocation: 1 }
    ));
    for step in &trace.steps[1..3] {
        let StepOutcome::Rejected { reason } = &step.outcome else {
            panic!("over-budget command must be rejected");
        };
        assert!(
            reason.contains("in-flight budget exceeded (1/1)"),
            "got: {reason}"
        );
        assert_eq!(step.digest.bus_in_flight, 1);
        assert_eq!(
            step.digest, trace.steps[0].digest,
            "rejections change nothing"
        );
    }

    // 超时预算 100ms:回放命令固定声明 1_000ms,提交即被拒。
    let tight = CommandBudget {
        max_command_timeout_ms: 100,
        ..CommandBudget::default()
    };
    let mut replay = host_with_budget(13, tight);
    let trace = replay.run(&ReplayScript::new(vec![ScriptEntry::Command {
        expected_revision: 0,
        key: "cmd-timeout-capped-1".into(),
        payload: BehaviorPayload::ClearSelection,
    }]));
    let StepOutcome::Rejected { reason } = &trace.steps[0].outcome else {
        panic!("timeout-capped command must be rejected");
    };
    assert!(reason.contains("timeout budget exceeded"), "got: {reason}");
    assert_eq!(trace.steps[0].digest.bus_revision, 0);
}

#[test]
fn same_seed_converges_and_different_seed_diverges_on_random_steps() {
    let script = ReplayScript::new(vec![ScriptEntry::Random { draws: 4 }]);
    let mut a = host(7);
    let mut b = host(7);
    let mut c = host(8);
    let trace_a = a.run(&script);
    let trace_b = b.run(&script);
    let trace_c = c.run(&script);
    assert_eq!(trace_a, trace_b, "same seed must converge byte-for-byte");
    let StepOutcome::Drawn { values: values_a } = &trace_a.steps[0].outcome else {
        panic!("random step must record its draws");
    };
    let StepOutcome::Drawn { values: values_c } = &trace_c.steps[0].outcome else {
        panic!("random step must record its draws");
    };
    assert_ne!(values_a, values_c, "different seeds must diverge");
    assert_ne!(trace_a.steps[0].display_hash, trace_c.steps[0].display_hash);
}
