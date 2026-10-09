//! T16 切片 1 的世界级测试:root motion → 物理位移贯通、坡度/台阶/跳跃/落地
//! 状态机、30/60/120Hz 渲染步长下的固定仿真确定性,以及 golden 轨迹落盘。
//!
//! 全部为 `#[cfg(test)]`,不进入发布产物。世界统一约定(米/秒/弧度):
//! 地面顶面 y=0;角色为 half=(0.25,0.5,0.25) 的 render-bounds cuboid,底部
//! 留 0.01(=offset)间隙落地;固定仿真步长 1/60 s,与宿主 `advance` 一致。

use super::native_animation_root_motion::{DEFAULT_ROOT_MOTION_HISTORY, NativeRootMotionTracker};
use super::native_character_motion::{
    CharacterMotionEventKind, CharacterMotionPhase, LandingImpact,
};
use super::native_physics::NativePhysicsHost;
use crate::contract::RenderPacket;

#[path = "native_character_motion_test_support.rs"]
mod support;

use self::support::{
    CHARACTER_GAP, CHARACTER_HALF_Y, SPAWN_Y, Scene, TICK_DT, WALK_SPEED_MPS, WALK_TICKS,
    box_obstacle, character_config, flat_world, ground_obstacle, ramp_obstacle, translation_of,
};

// ─── 贯通:平面速度 + 根运动 + 实例位姿回写 ─────────────────────────────────

#[test]
fn planar_velocity_walks_character_and_keeps_grounded() {
    let (mut host, mut packet) = flat_world();
    assert!(host.set_character_planar_velocity("body-char", [WALK_SPEED_MPS, 0.0]));
    for _ in 0..WALK_TICKS {
        host.advance(TICK_DT, &mut packet).unwrap();
    }
    let translation = translation_of(&packet, "inst-body-char");
    assert!(
        (translation[0] - 2.0).abs() < 0.05,
        "60 tick × 2 m/s 应前进约 2 m,实际 {translation:?}"
    );
    assert!(
        (translation[1] - SPAWN_Y).abs() < 0.02,
        "平地行走不应改变高度,实际 {translation:?}"
    );
    assert_eq!(
        host.character_phase("body-char"),
        Some(CharacterMotionPhase::Grounded)
    );
    // 角色实例现在可经 instance_pose 观测(T16 之前 kinematic 不可见)。
    let (tick, pose) = host.instance_pose(&packet, "inst-body-char").unwrap();
    assert_eq!(tick, WALK_TICKS as u64);
    assert_eq!(pose, translation);
}

#[test]
fn kinematic_without_character_config_stays_put() {
    let mut scene = Scene::new(
        CHARACTER_HALF_Y + CHARACTER_GAP,
        serde_json::json!(null),
        vec![ground_obstacle()],
    );
    // 该场景没有 character 配置:挂载会得到「无角色驱动器」的 kinematic。
    scene.runtime["physics"]["bodies"][0]
        .as_object_mut()
        .unwrap()
        .remove("character");
    let (mut host, mut packet) = scene.mount();
    assert_eq!(host.character_phase("body-char"), None);
    assert!(!host.set_character_planar_velocity("body-char", [1.0, 0.0]));
    assert!(!host.queue_character_root_motion("body-char", [1.0; 3], [0.0, 0.0, 0.0, 1.0]));
    assert!(!host.request_character_jump("body-char"));
    assert_eq!(host.advance(TICK_DT, &mut packet).unwrap(), 0);
    assert_eq!(
        translation_of(&packet, "inst-body-char"),
        [0.0, SPAWN_Y, 0.0]
    );
}

#[test]
fn root_motion_and_explicit_velocity_overlay_drive_one_body() {
    let (mut host, mut packet) = flat_world();
    // 根运动:1 m/s 沿 x(每 tick 1/60 m);显式速度:1 m/s 沿 z。
    assert!(host.set_character_planar_velocity("body-char", [0.0, 1.0]));
    for _ in 0..WALK_TICKS {
        assert!(host.queue_character_root_motion(
            "body-char",
            [TICK_DT, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0]
        ));
        host.advance(TICK_DT, &mut packet).unwrap();
    }
    let translation = translation_of(&packet, "inst-body-char");
    assert!(
        (translation[0] - 1.0).abs() < 0.03,
        "根运动分量 {translation:?}"
    );
    assert!(
        (translation[2] - 1.0).abs() < 0.03,
        "速度分量 {translation:?}"
    );
}

#[test]
fn root_motion_rotation_delta_composes_body_yaw() {
    let (mut host, mut packet) = flat_world();
    // 每 tick 1° 偏航增量,60 tick 后应累计 60°。
    let half = std::f64::consts::PI / 360.0;
    for _ in 0..WALK_TICKS {
        assert!(host.queue_character_root_motion(
            "body-char",
            [0.0; 3],
            [0.0, half.sin(), 0.0, half.cos()]
        ));
        host.advance(TICK_DT, &mut packet).unwrap();
    }
    let instance = &packet.instances[0];
    // 列主序:local x 轴 = 列 0 的 (m[0], m[2]);绕 y 旋转 60° 后指向 (cos60°, -sin60°)。
    let x_axis = [instance.transform[0], instance.transform[2]];
    assert!((x_axis[0] - 0.5).abs() < 0.02, "cos(60°) 分量 {x_axis:?}");
    assert!(
        (x_axis[1] + 60f64.to_radians().sin() as f32).abs() < 0.02,
        "sin(60°) 分量 {x_axis:?}"
    );
}

#[test]
fn root_motion_queue_is_consumed_once_per_fixed_tick() {
    let (mut host, mut packet) = flat_world();
    assert!(host.queue_character_root_motion("body-char", [0.5, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]));
    // 一次 advance 跨 2 个固定 tick:排队的增量只能被第一个 tick 消费。
    host.advance(2.0 * TICK_DT, &mut packet).unwrap();
    let after_two_ticks = translation_of(&packet, "inst-body-char");
    assert!((after_two_ticks[0] - 0.5).abs() < 1.0e-4);
    host.advance(TICK_DT, &mut packet).unwrap();
    let after_third_tick = translation_of(&packet, "inst-body-char");
    assert!(
        (after_third_tick[0] - after_two_ticks[0]).abs() < 1.0e-5,
        "已消费的根运动不得重复应用"
    );
}

#[test]
fn root_motion_tracker_watermark_protocol_feeds_physics() {
    // T14 → T16 消费协议:动画侧逐帧 record_advance;物理侧 accumulate(watermark)
    // → 排队 → 水印推进到 latest_unwrapped_time。任何划分下消费同一批样本。
    let mut tracker = NativeRootMotionTracker::new(DEFAULT_ROOT_MOTION_HISTORY).unwrap();
    let mut matrix = [0.0; 16];
    matrix[0] = 1.0;
    matrix[5] = 1.0;
    matrix[10] = 1.0;
    matrix[15] = 1.0;
    tracker.reset_baseline(&matrix).unwrap();
    let (mut host, mut packet) = flat_world();
    let mut watermark = 0.0_f64;
    for frame in 1..=WALK_TICKS {
        // 动画帧:根节点每帧前进 1 m/s × 1/60 s。
        matrix[12] = frame as f64 * TICK_DT;
        tracker
            .record_advance(&matrix, Some("walk"), frame as f64 * TICK_DT, 0)
            .unwrap();
        // 物理 tick:消费自水印以来的全部样本。
        if let Some(accumulation) = tracker.accumulate(watermark) {
            assert!(host.queue_character_root_motion(
                "body-char",
                accumulation.translation,
                accumulation.rotation
            ));
        }
        watermark = tracker.latest_unwrapped_time().unwrap();
        host.advance(TICK_DT, &mut packet).unwrap();
    }
    let translation = translation_of(&packet, "inst-body-char");
    assert!(
        (translation[0] - 1.0).abs() < 0.03,
        "水印协议贯通 {translation:?}"
    );
}

// ─── 状态机:坡度 / 台阶 / 跳跃 / 落地 ──────────────────────────────────────

#[test]
fn walkable_slope_is_climbed_and_phase_stays_grounded() {
    // 20° 缓坡(默认 max_climb 45°):沿坡上行,y 随 x 增加,阶段保持 Grounded。
    // 正 pitch 让表面沿 +x 升高;体心 (0.5,-0.11) 使坡面在 x≈0.55 处浮出地面。
    let (mut host, mut packet) = Scene::new(
        CHARACTER_HALF_Y + CHARACTER_GAP,
        character_config(serde_json::json!(null)),
        vec![
            ground_obstacle(),
            ramp_obstacle("body-ramp", [0.5, -0.11, 0.0], 20.0),
        ],
    )
    .mount();
    assert!(host.set_character_planar_velocity("body-char", [WALK_SPEED_MPS, 0.0]));
    let mut climbed = false;
    for _ in 0..WALK_TICKS {
        host.advance(TICK_DT, &mut packet).unwrap();
        let translation = translation_of(&packet, "inst-body-char");
        if translation[0] > 1.2 && translation[1] > 0.6 {
            climbed = true;
        }
    }
    let translation = translation_of(&packet, "inst-body-char");
    assert!(climbed, "应已登上缓坡(终点 {translation:?})");
    assert_eq!(
        host.character_phase("body-char"),
        Some(CharacterMotionPhase::Grounded)
    );
}

#[test]
fn steep_slope_blocks_progress_and_reports_sliding_phase() {
    // 60° 陡坡(超 max_climb 45°):水平推进被挡、不得上到高处。
    let (mut host, mut packet) = Scene::new(
        CHARACTER_HALF_Y + CHARACTER_GAP,
        character_config(serde_json::json!(null)),
        vec![
            ground_obstacle(),
            ramp_obstacle("body-ramp", [0.5, -0.14, 0.0], 60.0),
        ],
    )
    .mount();
    assert!(host.set_character_planar_velocity("body-char", [WALK_SPEED_MPS, 0.0]));
    for _ in 0..WALK_TICKS {
        host.advance(TICK_DT, &mut packet).unwrap();
    }
    let translation = translation_of(&packet, "inst-body-char");
    assert!(
        translation[0] < 1.4,
        "陡坡应阻挡水平推进(终点 {translation:?})"
    );
    assert!(
        translation[1] < 1.1,
        "不得被抬上陡坡高处(终点 {translation:?})"
    );

    // 出生于坡面上方:落在 60° 坡面(> min_slide 45°)→ SlidingDownSlope,
    // 沿坡滑落到坡底后回到平地 Grounded。
    let (mut host, mut packet) = Scene::new_at(
        0.9,
        2.6,
        character_config(serde_json::json!(null)),
        vec![
            ground_obstacle(),
            ramp_obstacle("body-ramp", [0.5, -0.14, 0.0], 60.0),
        ],
    )
    .mount();
    let mut saw_sliding = false;
    for _ in 0..WALK_TICKS {
        host.advance(TICK_DT, &mut packet).unwrap();
        if host.character_phase("body-char") == Some(CharacterMotionPhase::SlidingDownSlope) {
            saw_sliding = true;
        }
    }
    let translation = translation_of(&packet, "inst-body-char");
    assert!(
        saw_sliding,
        "落在 60° 坡面应进入 SlidingDownSlope 阶段(终点 {translation:?})"
    );
    // 静置站立时 Rapier 不产生滑行位移(滑行平移只在有移动输入时经 slide
    // 计算);状态机持续判定 SlidingDownSlope,角色保持被坡面托住的高位。
    assert!(
        translation[1] > 1.0 && (translation[0] - 0.9).abs() < 0.3,
        "应被坡面托住并持续处于滑行判定(终点 {translation:?})"
    );
}

#[test]
fn autostep_climbs_step_within_height() {
    // 0.25 m 台阶(autostep maxHeight 0.3):自动上步、SteppedUp 事件、继续前进。
    let (mut host, mut packet) = Scene::new(
        CHARACTER_HALF_Y + CHARACTER_GAP,
        character_config(serde_json::json!(null)),
        vec![
            ground_obstacle(),
            box_obstacle("body-step", [0.5, 0.0, -1.0], [2.0, 0.25, 1.0]),
        ],
    )
    .mount();
    assert!(host.set_character_planar_velocity("body-char", [1.0, 0.0]));
    for _ in 0..WALK_TICKS {
        host.advance(TICK_DT, &mut packet).unwrap();
    }
    let stepped_up = host.drain_character_events().iter().any(|event| {
        matches!(event.1.kind, CharacterMotionEventKind::SteppedUp { height_m } if height_m > 0.1)
    });
    let translation = translation_of(&packet, "inst-body-char");
    assert!(stepped_up, "应记录 SteppedUp 事件(终点 {translation:?})");
    assert!(
        (translation[1] - (0.25_f32 + SPAWN_Y)).abs() < 0.05,
        "应站上台阶面,实际 {translation:?}"
    );
    assert!(
        translation[0] > 0.9,
        "上步后应继续前进,实际 {translation:?}"
    );
    assert_eq!(
        host.character_phase("body-char"),
        Some(CharacterMotionPhase::Grounded)
    );
}

#[test]
fn taller_step_blocks_without_step_event() {
    // 0.6 m 高台(> maxHeight 0.3):水平被挡、无抬升、无 SteppedUp。
    let (mut host, mut packet) = Scene::new(
        CHARACTER_HALF_Y + CHARACTER_GAP,
        character_config(serde_json::json!(null)),
        vec![
            ground_obstacle(),
            box_obstacle("body-wall", [1.45, 0.0, -1.0], [2.0, 0.6, 1.0]),
        ],
    )
    .mount();
    assert!(host.set_character_planar_velocity("body-char", [1.0, 0.0]));
    for _ in 0..WALK_TICKS {
        host.advance(TICK_DT, &mut packet).unwrap();
    }
    let events = host.drain_character_events();
    let translation = translation_of(&packet, "inst-body-char");
    assert!(
        translation[0] < 1.35,
        "高台应阻挡水平推进,实际 {translation:?}"
    );
    assert!(
        (translation[1] - SPAWN_Y).abs() < 0.02,
        "不得被抬升高台,实际 {translation:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event.1.kind, CharacterMotionEventKind::SteppedUp { .. })),
        "超高台阶不得产生 SteppedUp 事件,实际 {events:?}"
    );
}

#[test]
fn jump_arcs_under_gravity_and_lands_with_graded_event() {
    let (mut host, mut packet) = flat_world();
    assert!(host.request_character_jump("body-char"));
    let mut max_height = 0.0_f32;
    let mut airborne = false;
    let mut landed_tick = None;
    for tick in 1..=240 {
        host.advance(TICK_DT, &mut packet).unwrap();
        max_height = max_height.max(translation_of(&packet, "inst-body-char")[1]);
        match host.character_phase("body-char") {
            Some(CharacterMotionPhase::Airborne) => airborne = true,
            Some(CharacterMotionPhase::Grounded) if airborne && tick > 1 => {
                landed_tick = Some(tick);
                break;
            }
            _ => {}
        }
    }
    let events: Vec<(String, super::native_character_motion::CharacterMotionEvent)> =
        host.drain_character_events();
    let heights = events.len();
    assert!(airborne, "跳跃应经历滞空阶段");
    assert!(
        max_height > SPAWN_Y + 0.8,
        "默认跳跃(5 m/s)应有明显弧线,峰值 {max_height}"
    );
    assert!(landed_tick.is_some(), "跳跃应落回地面");
    assert!(
        matches!(
            events.first().map(|event| event.1.kind),
            Some(CharacterMotionEventKind::Jumped)
        ),
        "首事件应为 Jumped,实际 {events:?}"
    );
    let landing = events.iter().find_map(|event| match event.1.kind {
        CharacterMotionEventKind::Landed {
            impact_speed_mps,
            impact,
        } => Some((impact_speed_mps, impact)),
        _ => None,
    });
    let (impact_speed, impact) = landing.expect("应记录 Landed 事件");
    // 默认跳跃 5 m/s、g=9.81:回到起跳高度的冲击速度 ≈ 5 m/s → Normal 档。
    assert!(
        (impact_speed - 5.0).abs() < 0.6,
        "冲击速度应≈起跳速度,实际 {impact_speed}(events={heights})"
    );
    assert_eq!(impact, LandingImpact::Normal);
    assert_eq!(
        host.character_phase("body-char"),
        Some(CharacterMotionPhase::Grounded)
    );
}

#[test]
fn landing_impact_grades_with_fall_height() {
    // 三档落地全部用落差表达:0.3 m → Light(<3 m/s),2 m → Normal,4 m → Hard。
    let drop_impact = |raise: f64| -> (f32, LandingImpact) {
        let (mut host, mut packet) = Scene::new(
            CHARACTER_HALF_Y + CHARACTER_GAP + raise,
            character_config(serde_json::json!(null)),
            vec![ground_obstacle()],
        )
        .mount();
        let mut impact = None;
        for _ in 0..600 {
            host.advance(TICK_DT, &mut packet).unwrap();
            for event in host.drain_character_events() {
                if let CharacterMotionEventKind::Landed {
                    impact_speed_mps,
                    impact: grade,
                } = event.1.kind
                {
                    impact = Some((impact_speed_mps, grade));
                }
            }
            if impact.is_some() {
                break;
            }
        }
        impact.expect("应记录落地事件")
    };
    let (light_speed, light) = drop_impact(0.3);
    assert_eq!(light, LandingImpact::Light, "0.3 m 落差应轻着陆");
    assert!(light_speed < 3.0, "轻档冲击速度 {light_speed}");
    let (normal_speed, normal) = drop_impact(2.0);
    assert_eq!(normal, LandingImpact::Normal, "2 m 落差应中档");
    assert!(
        (3.0..8.0).contains(&normal_speed),
        "中档冲击速度 {normal_speed}"
    );
    let (hard_speed, hard) = drop_impact(4.0);
    assert_eq!(hard, LandingImpact::Hard, "4 m 落差应重着陆");
    assert!(hard_speed >= 8.0, "重档冲击速度 {hard_speed}");
}

#[test]
fn buffered_jump_consumes_on_landing_tick() {
    // 滞空期请求跳跃:请求被缓冲,落地 tick 直接再次起跳(事件序 Landed→Jumped)。
    let (mut host, mut packet) = Scene::new(
        CHARACTER_HALF_Y + CHARACTER_GAP + 1.0,
        character_config(serde_json::json!(null)),
        vec![ground_obstacle()],
    )
    .mount();
    let mut impact_seen = false;
    for tick in 1..=300 {
        // tick 10 时仍在下落(1 m 落差约 27 tick):请求必须被缓冲到落地。
        if tick == 10 {
            assert!(host.request_character_jump("body-char"));
        }
        host.advance(TICK_DT, &mut packet).unwrap();
        for event in host.drain_character_events() {
            match event.1.kind {
                CharacterMotionEventKind::Landed { .. } => impact_seen = true,
                CharacterMotionEventKind::Jumped if impact_seen => {
                    // 落地 tick 直接消费缓冲:协议成立,提前收工。
                    assert!(
                        host.character_phase("body-char") == Some(CharacterMotionPhase::Airborne),
                        "消费缓冲跳跃后应立即滞空"
                    );
                    return;
                }
                CharacterMotionEventKind::Jumped => {
                    panic!("落地前不应起跳(事件序被破坏)")
                }
                CharacterMotionEventKind::SteppedUp { .. } => {}
            }
        }
    }
    panic!("缓冲跳跃未被消费(impact_seen={impact_seen})");
}

// ─── 确定性:30/60/120Hz 渲染步长 → 固定仿真轨迹逐位一致 ────────────────────

/// 关卡:地面 + 0.25 m 台阶(触发上步/SteppedUp)+ 1.45 m 处高墙(封顶边界)。
fn scripted_scenario() -> (NativePhysicsHost, RenderPacket) {
    Scene::new(
        CHARACTER_HALF_Y + CHARACTER_GAP,
        character_config(serde_json::json!(null)),
        vec![
            ground_obstacle(),
            box_obstacle("body-step", [0.5, 0.0, -1.0], [2.0, 0.25, 1.0]),
            box_obstacle("body-wall", [1.45, 0.0, -1.0], [2.0, 0.6, 1.0]),
        ],
    )
    .mount()
}

/// 输入脚本(固定 tick 协议:速度是持续态,跳跃是置位待消费标志)。
/// 边界全部取偶数 tick——它们是 1/60 与 1/30 渲染帧的公共帧边界,任何整
/// tick 划分都精确命中;指令幂等,重复命中(120Hz 的 0 步帧)无副作用。
fn apply_script(host: &mut NativePhysicsHost, completed_ticks: u64) {
    match completed_ticks {
        100 => {
            assert!(host.request_character_jump("body-char"));
        }
        220 => {
            // 跳跃约在 tick 162 落地:从地面步行穿越 0.25 m 台阶(触发 SteppedUp)。
            assert!(host.set_character_planar_velocity("body-char", [WALK_SPEED_MPS, 0.0]));
        }
        340 => {
            assert!(host.set_character_planar_velocity("body-char", [0.0, 0.75]));
        }
        440 => {
            assert!(host.set_character_planar_velocity("body-char", [0.0, 0.0]));
        }
        _ => {}
    }
}

enum Drive {
    /// 规范驱动:每次恰 1 个固定 tick(同 T19 advance_ticks)。
    PerTick,
    /// 渲染驱动:每帧 `advance(dt)`,累加器量化为整 tick。
    ByHz(f64),
}

/// 跑完 `total_ticks` 个固定 tick,按偶数 tick 边界采样轨迹(四种驱动的
/// 公共可观测子序列;1/30 帧恰跨 2 tick、1/120 帧交替 0/1 tick)。
fn run_scripted(
    drive: Drive,
    total_ticks: usize,
) -> (
    Vec<[f32; 3]>,
    Vec<(String, super::native_character_motion::CharacterMotionEvent)>,
) {
    let (mut host, mut packet) = scripted_scenario();
    let mut trajectory = Vec::new();
    let mut completed: u64 = 0;
    let mut last_recorded: u64 = 0;
    apply_script(&mut host, completed);
    while completed < total_ticks as u64 {
        match drive {
            Drive::PerTick => {
                host.advance_fixed_ticks(1, &mut packet).unwrap();
            }
            Drive::ByHz(dt) => {
                host.advance(dt, &mut packet).unwrap();
            }
        }
        completed = host.fixed_step_count();
        apply_script(&mut host, completed);
        if completed.is_multiple_of(2) && completed > last_recorded {
            trajectory.push(translation_of(&packet, "inst-body-char"));
            last_recorded = completed;
        }
    }
    let events = host.drain_character_events();
    (trajectory, events)
}

fn hash_trajectory(trajectory: &[[f32; 3]]) -> u64 {
    // FNV-1a over f32 bits(小端字节序):轨迹逐位敏感的稳定摘要。
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for translation in trajectory {
        for component in translation {
            for byte in component.to_bits().to_le_bytes() {
                hash ^= byte as u64;
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
    }
    hash
}

#[test]
fn trajectory_is_bit_identical_across_render_rates() {
    let total = 480;
    let (per_tick, per_tick_events) = run_scripted(Drive::PerTick, total);
    let (by_60, by_60_events) = run_scripted(Drive::ByHz(TICK_DT), total);
    let (by_30, by_30_events) = run_scripted(Drive::ByHz(2.0 * TICK_DT), total);
    let (by_120, by_120_events) = run_scripted(Drive::ByHz(0.5 * TICK_DT), total);

    let reference = hash_trajectory(&per_tick);
    assert_eq!(
        hash_trajectory(&by_60),
        reference,
        "60Hz 轨迹与逐 tick 驱动不一致"
    );
    assert_eq!(
        hash_trajectory(&by_30),
        reference,
        "30Hz 轨迹与逐 tick 驱动不一致"
    );
    assert_eq!(
        hash_trajectory(&by_120),
        reference,
        "120Hz 轨迹与逐 tick 驱动不一致"
    );
    assert_eq!(per_tick, by_60, "轨迹子序列必须逐位相等(to_bits 级)");
    assert_eq!(per_tick.len(), total / 2, "偶数边界采样应覆盖全部固定 tick");
    // 事件序列(tick + 类别 + 冲击分级)跨驱动一致。
    let same =
        |left: &[(String, super::native_character_motion::CharacterMotionEvent)],
         right: &[(String, super::native_character_motion::CharacterMotionEvent)]| {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| a == b)
        };
    assert!(same(&per_tick_events, &by_60_events));
    assert!(same(&per_tick_events, &by_30_events));
    assert!(same(&per_tick_events, &by_120_events));
    // 脚本有效性:必须真的发生过跳跃/台阶/落地,否则确定性断言在空序列上空转。
    assert!(
        per_tick_events
            .iter()
            .any(|event| matches!(event.1.kind, CharacterMotionEventKind::Jumped))
    );
    assert!(
        per_tick_events
            .iter()
            .any(|event| matches!(event.1.kind, CharacterMotionEventKind::SteppedUp { .. }))
    );
    assert!(
        per_tick_events
            .iter()
            .any(|event| matches!(event.1.kind, CharacterMotionEventKind::Landed { .. }))
    );
}

// ─── Golden:固定输入序列 → 轨迹落盘 → 断言 ─────────────────────────────────

#[test]
fn golden_trajectory_is_persisted_and_reproducible() {
    const GOLDEN_TRAJECTORY_FNV1A: u64 = 10504114052284501021;
    let (first, first_events) = run_scripted(Drive::PerTick, 480);
    let (second, _) = run_scripted(Drive::PerTick, 480);
    assert_eq!(first, second, "同输入两次运行必须逐位一致");
    assert_eq!(
        hash_trajectory(&first),
        GOLDEN_TRAJECTORY_FNV1A,
        "golden 轨迹摘要漂移:物理/状态机实现变更后必须复核并更新"
    );

    let directory = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-output/t16-character"
    );
    std::fs::create_dir_all(directory).expect("create t16 golden directory");
    let path = format!("{directory}/golden-trajectory.json");
    let payload = serde_json::json!({
        "schema": "deep-engine.t16-character-golden", "version": 1,
        "fixedStepSeconds": TICK_DT,
        "sampleEveryTicks": 2,
        "script": {
            "jumpRequestTick": 100,
            "velocityChanges": {"120": [2.0, 0.0], "240": [0.0, 0.75], "360": [0.0, 0.0]}
        },
        "trajectory": first,
        "events": first_events.iter().map(|(body, event)| serde_json::json!({
            "body": body, "tick": event.tick,
            "kind": match event.kind {
                CharacterMotionEventKind::Jumped => "jumped".to_string(),
                CharacterMotionEventKind::SteppedUp { height_m } => {
                    format!("stepped-up:{height_m}")
                }
                CharacterMotionEventKind::Landed { impact_speed_mps, impact } => {
                    format!("landed:{impact_speed_mps}:{impact:?}")
                }
            }
        })).collect::<Vec<_>>(),
        "fnv1a": hash_trajectory(&first)
    });
    std::fs::write(&path, serde_json::to_string(&payload).unwrap())
        .expect("write t16 golden trajectory");
}
