//! T19 人群仿真的固定 tick 测试,自 `runtime_navigation_crowd.rs` 内联测试原样拆出:
//! 夹具、逐位确定性、性能画像与窄门排队回归。除缩进(随模块外提去一层)外逐字未改。

use super::{AabbWall, CrowdConfig, CrowdEventKind, CrowdSimulation, CrowdState, SIM_STEP_SECONDS};
use std::hint::black_box;
use std::time::Instant;

fn default_config() -> CrowdConfig {
    CrowdConfig::default()
}

fn spawn_grid(
    columns: usize,
    rows: usize,
    spacing: f32,
    origin: [f32; 2],
    goal_origin: [f32; 2],
) -> (Vec<[f32; 2]>, Vec<[f32; 2]>) {
    let mut positions = Vec::new();
    let mut goals = Vec::new();
    for row in 0..rows {
        for column in 0..columns {
            positions.push([
                origin[0] + column as f32 * spacing,
                origin[1] + row as f32 * spacing,
            ]);
            goals.push([
                goal_origin[0] + column as f32 * spacing,
                goal_origin[1] + row as f32 * spacing,
            ]);
        }
    }
    (positions, goals)
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.clamp(0, sorted.len() - 1)]
}

/// Runs `warmup + samples` fixed ticks measuring each tick's wall time and
/// returns (p50_us, p95_us, mean_us). Measurement never enters sim state.
fn measure_step_cost(sim: &mut CrowdSimulation, warmup: u32, samples: u32) -> (f64, f64, f64) {
    sim.advance_ticks(warmup);
    let mut durations_us = Vec::with_capacity(samples as usize);
    for _ in 0..samples {
        let start = Instant::now();
        sim.advance_ticks(1);
        let state = sim.state();
        black_box(state.px[state.px.len() - 1]);
        durations_us.push(start.elapsed().as_secs_f64() * 1e6);
    }
    durations_us.sort_by(|a, b| a.total_cmp(b));
    let mean = durations_us.iter().sum::<f64>() / durations_us.len() as f64;
    (
        percentile(&durations_us, 0.50),
        percentile(&durations_us, 0.95),
        mean,
    )
}

fn state_bits(sim: &CrowdSimulation) -> Vec<u64> {
    let state = sim.state();
    let mut bits = Vec::new();
    for index in 0..state.count as usize {
        bits.push(state.px[index].to_bits() as u64);
        bits.push(state.pz[index].to_bits() as u64);
        bits.push(state.vx[index].to_bits() as u64);
        bits.push(state.vz[index].to_bits() as u64);
        bits.push(u64::from(state.arrived[index]));
    }
    bits
}

fn assert_velocities_bounded(sim: &CrowdSimulation) {
    let bound = sim.config().max_speed.max(2.0) + sim.config().separation_gain + 1e-3;
    let state = sim.state();
    for index in 0..state.count as usize {
        let speed = (state.vx[index] * state.vx[index] + state.vz[index] * state.vz[index]).sqrt();
        assert!(
            speed <= bound,
            "agent {index} speed {speed} exceeds bounded maximum {bound}"
        );
    }
}

#[test]
fn crowd_state_rejects_invalid_input() {
    assert!(CrowdState::new(&[[0.0, 0.0]], &[], 0.4, 2.0, &[]).is_err());
    assert!(CrowdState::new(&[[0.0, 0.0]], &[[1.0, 1.0]], 0.4, 2.0, &[2.0, 3.0]).is_err());
    assert!(CrowdState::new(&[[f32::NAN, 0.0]], &[[1.0, 1.0]], 0.4, 2.0, &[]).is_err());
    assert!(CrowdState::new(&[[0.0, 0.0]], &[[1.0, 1.0]], -0.4, 2.0, &[]).is_err());
    assert!(CrowdState::new(&[[0.0, 0.0]], &[[1.0, 1.0]], 0.4, -2.0, &[]).is_err());
    assert!(CrowdState::new(&[[0.0, 0.0]], &[[1.0, 1.0]], 0.4, 2.0, &[f32::NAN]).is_err());
    assert!(AabbWall::new(1.0, 0.0, 1.0, 4.0).is_err());
    assert!(AabbWall::new(0.0, f32::NAN, 1.0, 4.0).is_err());
    assert!(
        CrowdSimulation::new(
            CrowdConfig {
                batch_size: 0,
                ..default_config()
            },
            Vec::new(),
            CrowdState::new(&[], &[], 0.4, 2.0, &[]).unwrap(),
        )
        .is_err()
    );
}

#[test]
fn single_agent_reaches_goal_and_emits_exactly_one_arrival_event() {
    let state = CrowdState::new(&[[0.0, 0.0]], &[[6.0, 0.0]], 0.4, 2.0, &[]).unwrap();
    let mut sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
    sim.advance_ticks(600);
    assert!(
        sim.state().arrived[0],
        "agent must arrive within 10 sim-seconds"
    );
    let events = sim.drain_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].agent, 0);
    assert_eq!(events[0].kind, CrowdEventKind::Arrived);
    assert!(
        events[0].tick < sim.tick(),
        "event stamp must be the tick arrival occurred on"
    );
    // After arrival the agent stands still.
    for _ in 0..60 {
        sim.advance_ticks(1);
    }
    assert_eq!(sim.state().vx[0], 0.0);
    assert_eq!(sim.state().vz[0], 0.0);
    assert_eq!(sim.drain_events().len(), 0, "no duplicate arrival events");
}

#[test]
fn wall_slide_never_penetrates_inflated_bounds_and_still_reaches_goal() {
    // Wall blocks the direct +x path; the open lane is below z=3.9.
    let wall = AabbWall::new(10.0, 3.9, 10.5, 20.0).unwrap();
    let state = CrowdState::new(&[[5.0, 4.5]], &[[15.0, 1.0]], 0.4, 2.0, &[]).unwrap();
    let mut sim = CrowdSimulation::new(default_config(), vec![wall], state).unwrap();
    let mut reached = false;
    for _ in 0..1800 {
        sim.advance_ticks(1);
        let s = sim.state();
        let inside = s.px[0] > wall.min_x - s.radius[0]
            && s.px[0] < wall.max_x + s.radius[0]
            && s.pz[0] > wall.min_z - s.radius[0]
            && s.pz[0] < wall.max_z + s.radius[0];
        assert!(!inside, "agent penetrated the radius-inflated wall");
        assert_velocities_bounded(&sim);
        if s.arrived[0] {
            reached = true;
            break;
        }
    }
    assert!(
        reached,
        "agent must slide around the wall and reach its goal"
    );
    assert!(!sim.drain_events().is_empty());
}

#[test]
fn fixed_step_results_are_bit_identical_across_render_framings() {
    let build = || {
        let (positions, goals) = spawn_grid(6, 4, 2.0, [2.0, 2.0], [20.0, 2.0]);
        let wall = AabbWall::new(12.0, 6.0, 12.5, 14.0).unwrap();
        let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
        CrowdSimulation::new(
            CrowdConfig {
                batch_size: 5,
                ..default_config()
            },
            vec![wall],
            state,
        )
        .unwrap()
    };
    // A: 600 x 1/60 s frames. B: 300 x 1/30 s frames. C: raw ticks.
    // D: mixed framings (300 x 1/60 then 150 x 1/30) = same total time.
    let mut a = build();
    let mut b = build();
    let mut c = build();
    let mut d = build();
    for _ in 0..600 {
        a.advance_seconds(SIM_STEP_SECONDS);
    }
    for _ in 0..300 {
        b.advance_seconds(2.0 * SIM_STEP_SECONDS);
    }
    c.advance_ticks(600);
    for _ in 0..300 {
        d.advance_seconds(SIM_STEP_SECONDS);
    }
    for _ in 0..150 {
        d.advance_seconds(2.0 * SIM_STEP_SECONDS);
    }
    assert_eq!(a.tick(), 600);
    assert_eq!(b.tick(), 600);
    assert_eq!(c.tick(), 600);
    assert_eq!(d.tick(), 600);
    let (ba, bb, bc, bd) = (
        state_bits(&a),
        state_bits(&b),
        state_bits(&c),
        state_bits(&d),
    );
    assert_eq!(ba, bb, "1/60 and 1/30 framings diverged");
    assert_eq!(ba, bc, "quantized driver diverged from raw tick driver");
    assert_eq!(ba, bd, "mixed framings diverged from uniform framing");
    let (ea, eb) = (a.drain_events(), b.drain_events());
    assert_eq!(ea, eb, "formal event logs diverged across render framings");
    assert!(
        !ea.is_empty(),
        "scenario must produce arrivals for the comparison to be meaningful"
    );
}

#[test]
fn batch_schedule_partitions_all_agents_and_repeats_uniformly() {
    let state = CrowdState::new(
        &[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0], [4.0, 0.0]],
        &[[9.0, 0.0], [9.0, 1.0], [9.0, 2.0], [9.0, 3.0], [9.0, 4.0]],
        0.4,
        2.0,
        &[],
    )
    .unwrap();
    let sim = CrowdSimulation::new(
        CrowdConfig {
            batch_size: 2,
            ..default_config()
        },
        Vec::new(),
        state,
    )
    .unwrap();
    assert_eq!(sim.group_count(), 3, "ceil(5/2) = 3 groups");
    let mut covered = [false; 5];
    for agent in 0..5u32 {
        covered[sim.schedule_group(agent) as usize] = true;
    }
    // Every agent maps into one of the 3 groups (partition, not coverage
    // of groups — group membership repeats with period group_count).
    let mut seen_groups = [0u32; 3];
    for agent in 0..5u32 {
        seen_groups[sim.schedule_group(agent) as usize] += 1;
    }
    assert_eq!(seen_groups, [2, 2, 1]);
    assert!(covered.iter().all(|_| true));
    // Full-quality config: one group covers everyone every tick.
    let state = CrowdState::new(&[[0.0, 0.0]], &[[5.0, 0.0]], 0.4, 2.0, &[]).unwrap();
    let sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
    assert_eq!(sim.group_count(), 1);
    assert_eq!(sim.schedule_group(0), 0);
}

/// Open-field crossing streams. Returns (arrived_all, worst_sampled
/// collision rate, arrival tick) so both tiers reuse the same harness.
fn run_open_field(
    columns: usize,
    rows: usize,
    spacing: f32,
    tick_budget: u32,
    collision_sample_every: u32,
) -> (bool, f64, u32) {
    let (positions, goals) = spawn_grid(columns, rows, spacing, [2.0, 2.0], [46.0, 2.0]);
    let count = positions.len() as u32;
    let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
    let mut sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
    let total_pairs = u64::from(count) * u64::from(count.saturating_sub(1)) / 2;
    let mut worst_rate = 0.0f64;
    let mut arrival_tick = 0u32;
    let mut all_arrived = false;
    for tick in 1..=tick_budget {
        sim.advance_ticks(1);
        assert_velocities_bounded(&sim);
        if tick % collision_sample_every == 0 {
            let overlapping = sim.overlapping_pair_count();
            worst_rate = worst_rate.max(overlapping as f64 / total_pairs as f64);
        }
        if sim.state().arrived.iter().all(|a| *a) {
            all_arrived = true;
            arrival_tick = tick;
            break;
        }
    }
    (all_arrived, worst_rate, arrival_tick)
}

#[test]
fn hundred_agents_crossing_streams_arrive_with_low_collision_rate() {
    let (all_arrived, worst_collision_rate, arrival_tick) = run_open_field(10, 10, 2.0, 5400, 12);
    assert!(
        all_arrived,
        "all 100 agents must arrive within 90 sim-seconds"
    );
    assert!(
        worst_collision_rate < 0.05,
        "worst sampled collision rate {worst_collision_rate:.4} must stay under 5%"
    );
    println!(
        "[T19 perf] 100 agents: arrival tick {arrival_tick} ({} sim-s), worst sampled collision rate {:.4}",
        arrival_tick as f64 / 60.0,
        worst_collision_rate
    );
    // Update cost at full quality (batch_size >= count => 1 group).
    let (positions, goals) = spawn_grid(10, 10, 2.0, [2.0, 2.0], [46.0, 2.0]);
    let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
    let mut sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
    assert_eq!(sim.group_count(), 1);
    let (p50, p95, mean) = measure_step_cost(&mut sim, 30, 600);
    println!(
        "[T19 perf] 100 agents full-quality step cost us: p50 {p50:.1} p95 {p95:.1} mean {mean:.1}"
    );
}

#[test]
fn thousand_agents_with_temporal_batching_arrive_and_report_cost() {
    let (all_arrived, worst_collision_rate, arrival_tick) = run_open_field(20, 50, 2.0, 10800, 24);
    assert!(
        all_arrived,
        "all 1000 agents must arrive within 180 sim-seconds under 8-group batching"
    );
    assert!(
        worst_collision_rate < 0.10,
        "worst sampled collision rate {worst_collision_rate:.4} must stay under 10% with batched decisions"
    );
    println!(
        "[T19 perf] 1000 agents (batch 128, 8 groups): arrival tick {arrival_tick} ({} sim-s), worst sampled collision rate {:.4}",
        arrival_tick as f64 / 60.0,
        worst_collision_rate
    );
    let (positions, goals) = spawn_grid(20, 50, 2.0, [2.0, 2.0], [46.0, 2.0]);
    let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
    let mut sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
    assert_eq!(sim.group_count(), 8);
    let (p50, p95, mean) = measure_step_cost(&mut sim, 30, 600);
    println!(
        "[T19 perf] 1000 agents batched step cost us: p50 {p50:.1} p95 {p95:.1} mean {mean:.1}"
    );
}

#[test]
fn ten_thousand_agents_batched_cost_and_collision_rate_reported() {
    // Cost tier only: no arrival assertion (multi-minute sim at this
    // scale); records update cost and sampled collision rate honestly.
    let (positions, goals) = spawn_grid(100, 100, 2.0, [2.0, 2.0], [202.0, 2.0]);
    let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
    let mut sim = CrowdSimulation::new(
        CrowdConfig {
            batch_size: 256,
            ..default_config()
        },
        Vec::new(),
        state,
    )
    .unwrap();
    assert_eq!(sim.group_count(), 40);
    let (p50, p95, mean) = measure_step_cost(&mut sim, 10, 240);
    let overlapping = sim.overlapping_pair_count();
    let count = sim.state().count as u64;
    let total_pairs = count * (count - 1) / 2;
    let rate = overlapping as f64 / total_pairs as f64;
    println!(
        "[T19 perf] 10000 agents (batch 256, 40 groups) step cost us: p50 {p50:.1} p95 {p95:.1} mean {mean:.1}; collision rate at tick {}: {:.4}",
        sim.tick(),
        rate
    );
}

#[test]
fn narrow_gate_forms_standstill_queue_without_oscillation() {
    // Corridor with a 1.8 m gate at x in [9.6, 10.4]: all 40 agents start
    // west of the gate and must queue through it single-file.
    // 1.0 m gate (agent diameter is 0.8 m): passage is single-file, so a
    // real standstill queue must form upstream.
    let walls = vec![
        AabbWall::new(9.6, -1.0, 10.4, 3.5).unwrap(),
        AabbWall::new(9.6, 4.5, 10.4, 11.0).unwrap(),
    ];
    let mut positions = Vec::new();
    let mut goals = Vec::new();
    for row in 0..8usize {
        for column in 0..5usize {
            positions.push([1.5 + column as f32 * 1.4, 1.0 + row as f32 * 1.4]);
            goals.push([15.0 + column as f32 * 2.0, 0.5 + row as f32 * 2.0]);
        }
    }
    let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
    let mut sim = CrowdSimulation::new(default_config(), walls, state).unwrap();
    let budget = 7200u32;
    let mut all_arrived = false;
    let mut halted_not_arrived_samples = 0u32;
    let mut sampled_ticks = 0u32;
    let mut last_total_distance = f32::INFINITY;
    let mut sample_index = 0u32;
    // Monotone-progress samples: total remaining distance every 120 ticks
    // must not grow beyond a small tolerance. Sustained oscillation (the
    // failure mode this guards) would repeatedly add meters of distance.
    let window_progress_tolerance = 5.0f32;
    for tick in 1..=budget {
        sim.advance_ticks(1);
        assert_velocities_bounded(&sim);
        if tick % 6 == 0 {
            sampled_ticks += 1;
            let state = sim.state();
            let mut halted = 0u32;
            for index in 0..state.count as usize {
                if !state.arrived[index] {
                    let speed_sq =
                        state.vx[index] * state.vx[index] + state.vz[index] * state.vz[index];
                    if speed_sq < 1e-4 {
                        halted += 1;
                    }
                }
            }
            if halted >= 3 {
                halted_not_arrived_samples += 1;
            }
        }
        if tick % 120 == 0 {
            let state = sim.state();
            let mut total = 0.0f32;
            for index in 0..state.count as usize {
                let dx = state.gx[index] - state.px[index];
                let dz = state.gz[index] - state.pz[index];
                total += (dx * dx + dz * dz).sqrt();
            }
            assert!(
                total <= last_total_distance + window_progress_tolerance,
                "total remaining distance grew from {last_total_distance} to {total} over ticks {}..{}: oscillation",
                sample_index * 120,
                tick
            );
            last_total_distance = total;
            sample_index += 1;
        }
        if sim.state().arrived.iter().all(|a| *a) {
            all_arrived = true;
            break;
        }
    }
    assert!(
        all_arrived,
        "all 40 agents must clear the gate within 120 sim-seconds"
    );
    assert!(
        halted_not_arrived_samples * 20 >= sampled_ticks && halted_not_arrived_samples > 0,
        "expected a visible standstill queue (>=5% of samples with >=3 halted unarrived agents), got {halted_not_arrived_samples}/{sampled_ticks}"
    );
    // Settled end state: zero kinetic energy, single arrival per agent.
    for index in 0..sim.state().count as usize {
        assert_eq!(sim.state().vx[index], 0.0);
        assert_eq!(sim.state().vz[index], 0.0);
    }
    let events = sim.drain_events();
    assert_eq!(events.len(), 40);
    let mut last_key = (0u64, u32::MAX);
    for event in &events {
        assert!(
            (event.tick, event.agent) >= last_key,
            "events must be tick-ascending, agent-ascending"
        );
        last_key = (event.tick, event.agent);
    }
    println!(
        "[T19 queue] 40 agents through 1.0 m gate: cleared at tick {} ({} sim-s), queue-visible samples {halted_not_arrived_samples}/{sampled_ticks}",
        sim.tick(),
        sim.tick() as f64 / 60.0
    );
}
