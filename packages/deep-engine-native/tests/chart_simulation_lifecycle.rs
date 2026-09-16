//! P1-12 sim 普通窗口与失败恢复:取消/换包/恢复与定时边界,全部固定时钟,无真实等待。
use deep_engine_native::chart::simulation::{
    ChartSimFrame, ChartSimulationSource, parse_chart_sim_fixture,
};
use deep_engine_native::chart::{ChartRuntime, parse_chart_ir};
use serde_json::{Value, json};

const START_MS: u64 = 1_700_000_000_000;

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
fn source(interval_ms: u64, start_time_ms: u64, chart: &ChartRuntime) -> ChartSimulationSource {
    let fixture = json!({
        "schema": "deep-engine.chart-sim", "schemaVersion": 1,
        "id": "lifecycle-sim", "chartId": "chart-v1-golden", "datasetId": "main",
        "dimensions": ["x", "y", "value", "name"],
        "rows": [["C", 3, 0.3, "泵三"], ["D", 4, 0.4, "水箱四"], ["E", 5, 0.5, "泵五"]],
        "seed": 1, "intervalMs": interval_ms, "startTimeMs": start_time_ms, "maxRows": 3
    });
    let bytes = serde_json::to_vec(&fixture).unwrap();
    ChartSimulationSource::new(parse_chart_sim_fixture(&bytes).unwrap(), chart).unwrap()
}
/// seed=1、rows=[C,D,E]:tick 的 x 维滚动序列。
fn tick_x(tick: u64) -> Value {
    json!(["C", "D", "E"][((1 + tick) % 3) as usize])
}
/// 一次完整的「prepare → 候选应用 → commit」,返回该帧 x 维并校验 start_time 偏移。
fn step(
    sim: &mut ChartSimulationSource,
    chart: &mut ChartRuntime,
    start_ms: u64,
    elapsed: u64,
) -> Value {
    let frame: ChartSimFrame = sim
        .prepare(elapsed, chart.data_revision())
        .unwrap()
        .unwrap();
    let captured = frame.captured_at_ms;
    chart.apply_data_message(frame.message().clone()).unwrap();
    sim.commit(frame, chart.data_revision()).unwrap();
    // commit 后 next_due = (tick+1)*interval:回推本帧 tick,校验 captured = start + tick*interval。
    let tick = sim.next_due_ms().unwrap() / sim.interval_ms() - 1;
    assert_eq!(
        captured,
        start_ms + tick * sim.interval_ms(),
        "captured_at must be start_time + tick*interval"
    );
    tick_x(tick)
}

#[test]
fn cancelled_source_is_terminal_and_reports_no_due() {
    let chart = runtime();
    let mut sim = source(100, START_MS, &chart);
    let pending = sim.prepare(0, 0).unwrap().unwrap();
    sim.cancel();
    sim.cancel(); // 重复取消幂等
    assert!(sim.is_cancelled());
    assert!(sim.prepare(0, 0).unwrap().is_none());
    assert!(sim.prepare(u64::MAX, 5).unwrap().is_none());
    // 取消即终态:没有下一次到期,调度方必须停止等待而不是拿到可等待的时刻。
    assert_eq!(sim.next_due_ms().unwrap_err(), "sim source cancelled");
    assert!(sim.commit(pending, 1).is_err()); // 取消前准备的帧不能复活
}

#[test]
fn max_interval_waits_a_full_day_between_samples() {
    let mut chart = runtime();
    let mut sim = source(86_400_000, START_MS, &chart);
    // tick0 在 t=0 到期;极慢 interval 决定的是后续样本的间隔。
    assert_eq!(json!("D"), step(&mut sim, &mut chart, START_MS, 0));
    assert!(
        sim.prepare(86_399_999, chart.data_revision())
            .unwrap()
            .is_none()
    );
    // start_time 偏移在极慢样本下依然精确:captured = start + tick*interval。
    assert_eq!(json!("E"), step(&mut sim, &mut chart, START_MS, 86_400_000));
    assert_eq!(sim.next_due_ms().unwrap(), 172_800_000);
    assert!(
        sim.prepare(172_799_999, chart.data_revision())
            .unwrap()
            .is_none()
    );
}

#[test]
fn one_ms_interval_backlog_replays_every_tick_in_order_without_skipping() {
    let mut chart = runtime();
    let mut sim = source(1, START_MS, &chart);
    // 宿主一次睡过 50 个 tick:醒来后 elapsed 固定为 50,必须逐帧补齐且不跳样本。
    for tick in 0..50u64 {
        let frame = sim.prepare(50, chart.data_revision()).unwrap().unwrap();
        assert_eq!(
            frame.captured_at_ms,
            START_MS + tick,
            "tick {tick} replayed out of order"
        );
        assert_eq!(frame.message().data_revision, tick + 1);
        chart.apply_data_message(frame.message().clone()).unwrap();
        sim.commit(frame, chart.data_revision()).unwrap();
        assert_eq!(
            chart.source().datasets[0].rows.last().unwrap()[0],
            tick_x(tick)
        );
    }
    // 睡过的时长内逐帧到期:elapsed=50 恰好让 tick50 到期,再之后才无产出。
    let frame = sim.prepare(50, chart.data_revision()).unwrap().unwrap();
    assert_eq!(frame.captured_at_ms, START_MS + 50);
    chart.apply_data_message(frame.message().clone()).unwrap();
    sim.commit(frame, chart.data_revision()).unwrap();
    assert!(sim.prepare(50, chart.data_revision()).unwrap().is_none());
    assert_eq!(sim.next_due_ms().unwrap(), 51);
    // 同一 tick 的两份 prepared 帧只能提交一份,不能把时钟拨快两次。
    let first = sim.prepare(60, chart.data_revision()).unwrap().unwrap();
    let duplicate = sim.prepare(60, chart.data_revision()).unwrap().unwrap();
    chart.apply_data_message(first.message().clone()).unwrap();
    sim.commit(first, chart.data_revision()).unwrap();
    assert!(sim.commit(duplicate, chart.data_revision()).is_err());
}

#[test]
fn gpu_candidate_failure_keeps_cursor_then_resumes_without_gap() {
    let mut chart = runtime();
    let mut sim = source(100, START_MS, &chart);
    assert_eq!(json!("D"), step(&mut sim, &mut chart, START_MS, 0));
    // tick1:候选在 GPU stage 后被拒绝 —— 候选整体丢弃,活动图表与生产游标都不动。
    let frame = sim.prepare(150, chart.data_revision()).unwrap().unwrap();
    let mut candidate = chart.clone();
    candidate
        .apply_data_message(frame.message().clone())
        .unwrap();
    drop(candidate);
    assert!(sim.commit(frame, chart.data_revision()).is_err());
    assert_eq!(
        sim.next_due_ms().unwrap(),
        100,
        "cursor must stay on tick 1"
    );
    assert_eq!(chart.data_revision(), 1);
    // 恢复:从原游标重跑 tick1 并连续推进 tick2、tick3,captured_at 连续、样本无缺口。
    let mut x_tail = Vec::new();
    for elapsed in [150u64, 250, 350] {
        x_tail.push(step(&mut sim, &mut chart, START_MS, elapsed));
    }
    assert_eq!(x_tail, vec![json!("E"), json!("C"), json!("D")]);
    assert_eq!(chart.source().datasets[0].rows.len(), 3);
}

#[test]
fn elapsed_extremes_guard_the_clock() {
    let mut chart = runtime();
    let mut sim = source(100, 0, &chart);
    assert!(sim.prepare(9_007_199_254_740_992, 0).is_err());
    // 上限值仍然有效:start_time=0 时 due 与时间戳都不越界,游标持续推进。
    assert_eq!(
        json!("D"),
        step(&mut sim, &mut chart, 0, 9_007_199_254_740_991)
    );
    assert_eq!(sim.next_due_ms().unwrap(), 100);
    assert_eq!(
        json!("E"),
        step(&mut sim, &mut chart, 0, 9_007_199_254_740_991)
    );
    assert_eq!(sim.next_due_ms().unwrap(), 200);
}
