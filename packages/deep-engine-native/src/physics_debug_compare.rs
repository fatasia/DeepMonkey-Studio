//! Brief-PhysDbg 物理调试器跨端位姿比对合同(native 侧镜像,2026-10-03)。
//!
//! 与 TS 真源 `packages/deep-engine/src/physics/debugRecorder.ts` 逐位同构,
//! 共享 fixture `tests/fixtures/physics-debug-compare-v1.json`(由
//! `packages/deep-engine/scripts/physicsDebugFixtureGen.mts` 经产品实现
//! `PhysicsDebugRecorder` 生成,哈希即产品值,非测试镜像):
//! 1. **哈希合同**:FNV-1a 双车道 over f32 小端字节(正序/反序各一条 32 位链),
//!    种子 0x811c9dc5、素数 0x01000193;链哈希 `chain = fnv1a(chain ⊕ tickHash)`
//!    双车道独立混入。
//! 2. **f32 场景逐位**:半隐式欧拉抛物体 + 四元数自旋(90 ticks × 3 体),与 TS
//!    `stepTick` 逐运算同构(Rust f32 为 IEEE-754 正确舍入且从不合浮点;
//!    fround(f64 单运算) == f32 单运算,由双舍入免疫定理保证,Figueroa:
//!    53 ≥ 2·24+2)。位姿逐位、逐 tick 哈希、链哈希与夹具全比对。
//! 3. **偏差定位**:tick 37 body 0 注入 +f32(2e-3) 后,1e-3 容差比对把首超差
//!    tick、首哈希失配 tick、超差计数全部定位(与夹具 expected* 字段互钉)。
//!
//! 本文件为新增模块,不触碰 native_physics*/cloth*/runtime_navigation*。
//! 改任何场景参数必须与 TS 生成脚本两侧同步。

/// FNV-1a 偏移基(与 TS fingerprintFloat32 同种子)。
pub const PHYSICS_DEBUG_FNV_OFFSET: u32 = 0x811c_9dc5;
/// FNV-1a 素数。
pub const PHYSICS_DEBUG_FNV_PRIME: u32 = 0x0100_0193;
/// 与 TS `PHYSICS_DEBUG_DEFAULT_COMPARE_TOLERANCE` 同源(米)。
pub const PHYSICS_DEBUG_POSITION_TOLERANCE_METERS: f64 = 1e-3;
/// 与 TS 同源(弧度,短弧角)。
pub const PHYSICS_DEBUG_ROTATION_TOLERANCE_RADIANS: f64 = 1e-3;
/// 位姿块布局:每体 px,py,pz,qx,qy,qz,qw(7 f32,与 TS PHYSICS_DEBUG_POSE_STRIDE 同)。
pub const PHYSICS_DEBUG_POSE_STRIDE: usize = 7;

/// FNV-1a 双车道 over f32 小端字节(与 TS `fingerprintFloat32` 逐字节同构:
/// 正向车道每字内字节序 0..3,反向车道 3..0、字序仍正向)。
pub fn fnv1a_dual_lane_f32(values: &[f32]) -> (u32, u32) {
    let mut forward = PHYSICS_DEBUG_FNV_OFFSET;
    let mut backward = PHYSICS_DEBUG_FNV_OFFSET;
    for value in values {
        let bytes = value.to_le_bytes();
        for index in 0..4 {
            forward = (forward ^ u32::from(bytes[index])).wrapping_mul(PHYSICS_DEBUG_FNV_PRIME);
            backward =
                (backward ^ u32::from(bytes[3 - index])).wrapping_mul(PHYSICS_DEBUG_FNV_PRIME);
        }
    }
    (forward, backward)
}

/// 链哈希推进(与 TS `chainMix` 同构):chain = fnv1a(chain ⊕ tickHash)。
/// XOR 不可能溢出,直接用 `^`。
pub fn chain_mix(chain: u32, tick_hash: u32) -> u32 {
    (chain ^ tick_hash).wrapping_mul(PHYSICS_DEBUG_FNV_PRIME)
}

/// 单 tick 位姿块哈希(16 位十六进制,与 TS `tickHashAt`/JSON `hash` 同格式)。
pub fn pose_tick_hash(poses: &[f32]) -> String {
    let (forward, backward) = fnv1a_dual_lane_f32(poses);
    format!("{forward:08x}{backward:08x}")
}

/// 双车道链哈希终态(16 位十六进制,与 TS `chainHash` 同格式)。
pub fn pose_chain_hash(lanes: &[(u32, u32)]) -> String {
    let mut forward = PHYSICS_DEBUG_FNV_OFFSET;
    let mut backward = PHYSICS_DEBUG_FNV_OFFSET;
    for (tick_forward, tick_backward) in lanes {
        forward = chain_mix(forward, *tick_forward);
        backward = chain_mix(backward, *tick_backward);
    }
    format!("{forward:08x}{backward:08x}")
}

// ─── f32 场景镜像(与 TS physicsDebugFixtureGen.mts stepTick 逐运算同构) ──────

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ScenarioBody {
    pub p: [f32; 3],
    pub v: [f32; 3],
    pub w: [f32; 3],
    pub q: [f32; 4],
}

pub fn scenario_initial_bodies() -> Vec<ScenarioBody> {
    vec![
        ScenarioBody {
            p: [0.5, 2.0, 0.0],
            v: [0.25, 0.0, 0.1],
            w: [0.5, 0.75, 0.25],
            q: [0.0, 0.0, 0.0, 1.0],
        },
        ScenarioBody {
            p: [1.0, 1.75, 0.0],
            v: [0.5, 0.0, 0.2],
            w: [0.75, 0.75, 0.25],
            q: [0.0, 0.0, 0.0, 1.0],
        },
        ScenarioBody {
            p: [1.5, 1.5, 0.0],
            v: [0.75, 0.0, 0.3],
            w: [1.0, 0.75, 0.25],
            q: [0.0, 0.0, 0.0, 1.0],
        },
    ]
}

/// 推进一个固定步;运算序与 TS 逐式一致(浮点加法严格左结合),改任何一步必须两侧同步。
pub fn step_tick(bodies: &mut [ScenarioBody], dt: f32, gravity_y: f32) {
    for body in bodies.iter_mut() {
        let [px, py, pz] = body.p;
        let [vx, vy, vz] = body.v;
        let [qx, qy, qz, qw] = body.q;
        let [wx, wy, wz] = body.w;
        // 半隐式欧拉:先速度后位置;y 轴受重力。
        let vy1 = vy + gravity_y * dt;
        body.v = [vx, vy1, vz];
        body.p = [px + vx * dt, py + vy1 * dt, pz + vz * dt];
        // 四元数积分:q̇ = 0.5·(ω⊗q);乘积分量 = (wx·qw + wy·qz − wz·qy,
        // wy·qw + wz·qx − wx·qz, wz·qw + wx·qy − wy·qx, −(wx·qx + wy·qy + wz·qz))。
        let half_dt = 0.5f32 * dt;
        let dqx = half_dt * ((wx * qw + wy * qz) - wz * qy);
        let dqy = half_dt * ((wy * qw + wz * qx) - wx * qz);
        let dqz = half_dt * ((wz * qw + wx * qy) - wy * qx);
        let dqw = half_dt * -((wx * qx + wy * qy) + wz * qz);
        let nqx = qx + dqx;
        let nqy = qy + dqy;
        let nqz = qz + dqz;
        let nqw = qw + dqw;
        // 单位化:范数平方固定序 (((qx²+qy²)+qz²)+qw²),浮点加法严格左结合。
        let norm_sq = nqx * nqx + nqy * nqy + nqz * nqz + nqw * nqw;
        let norm = norm_sq.sqrt();
        body.q = [nqx / norm, nqy / norm, nqz / norm, nqw / norm];
    }
}

pub fn scenario_pose_block(bodies: &[ScenarioBody]) -> Vec<f32> {
    let mut block = Vec::with_capacity(bodies.len() * PHYSICS_DEBUG_POSE_STRIDE);
    for body in bodies {
        block.extend_from_slice(&body.p);
        block.extend_from_slice(&body.q);
    }
    block
}

// ─── 容差比对(与 TS comparePhysicsDebugRecordingTicks 同构;哈希相等走逐位快路径) ──

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompareTickRow {
    pub tick: u32,
    pub hash_match: bool,
    pub max_position: f64,
    pub max_rotation: f64,
    pub exceeded: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompareOutcome {
    pub rows: Vec<CompareTickRow>,
    pub max_position: f64,
    pub max_rotation: f64,
    pub first_exceeded_tick: Option<u32>,
    pub first_hash_mismatch_tick: Option<u32>,
    pub exceeded_tick_count: usize,
}

/// 一段录制快照的最小消费形态(tick 号、逐 tick 哈希、位姿块三者按下标对齐)。
pub struct PoseRecordingView<'a> {
    pub ticks: &'a [u32],
    pub hashes: &'a [String],
    pub poses: &'a [Vec<f32>],
}

fn quaternion_angle(a: &[f32], offset: usize, b: &[f32]) -> f64 {
    let dot = (a[offset + 3] as f64) * (b[offset + 3] as f64)
        + (a[offset + 4] as f64) * (b[offset + 4] as f64)
        + (a[offset + 5] as f64) * (b[offset + 5] as f64)
        + (a[offset + 6] as f64) * (b[offset + 6] as f64);
    2.0 * (1.0f64.min(dot.abs())).acos()
}

/// 按 tick 号对齐比较;哈希相等即逐位一致(快路径,不进浮点差)。
pub fn compare_pose_recordings(
    a: &PoseRecordingView<'_>,
    b: &PoseRecordingView<'_>,
    position_tolerance: f64,
    rotation_tolerance: f64,
) -> CompareOutcome {
    let mut rows = Vec::new();
    let mut max_position = 0.0f64;
    let mut max_rotation = 0.0f64;
    let mut first_exceeded_tick = None;
    let mut first_hash_mismatch_tick = None;
    let mut exceeded_tick_count = 0usize;
    for (index, tick) in a.ticks.iter().enumerate() {
        let b_index = match b.ticks.iter().position(|candidate| candidate == tick) {
            Some(found) => found,
            None => continue, // 步号错位宁少比不错比(与 TS 同口径)。
        };
        let poses_a = &a.poses[index];
        let poses_b = &b.poses[b_index];
        let hash_match = a.hashes[index] == b.hashes[b_index];
        if !hash_match && first_hash_mismatch_tick.is_none() {
            first_hash_mismatch_tick = Some(*tick);
        }
        if hash_match && poses_a.len() == poses_b.len() {
            rows.push(CompareTickRow {
                tick: *tick,
                hash_match: true,
                max_position: 0.0,
                max_rotation: 0.0,
                exceeded: false,
            });
            continue;
        }
        let body_count = poses_a.len().min(poses_b.len()) / PHYSICS_DEBUG_POSE_STRIDE;
        let mut step_max_position = 0.0f64;
        let mut step_max_rotation = 0.0f64;
        for body in 0..body_count {
            let offset = body * PHYSICS_DEBUG_POSE_STRIDE;
            let dx = (poses_a[offset] as f64) - (poses_b[offset] as f64);
            let dy = (poses_a[offset + 1] as f64) - (poses_b[offset + 1] as f64);
            let dz = (poses_a[offset + 2] as f64) - (poses_b[offset + 2] as f64);
            step_max_position = step_max_position.max((dx * dx + dy * dy + dz * dz).sqrt());
            step_max_rotation = step_max_rotation.max(quaternion_angle(poses_a, offset, poses_b));
        }
        let exceeded =
            step_max_position > position_tolerance || step_max_rotation > rotation_tolerance;
        if exceeded {
            exceeded_tick_count += 1;
            if first_exceeded_tick.is_none() {
                first_exceeded_tick = Some(*tick);
            }
        }
        max_position = max_position.max(step_max_position);
        max_rotation = max_rotation.max(step_max_rotation);
        rows.push(CompareTickRow {
            tick: *tick,
            hash_match,
            max_position: step_max_position,
            max_rotation: step_max_rotation,
            exceeded,
        });
    }
    CompareOutcome {
        rows,
        max_position,
        max_rotation,
        first_exceeded_tick,
        first_hash_mismatch_tick,
        exceeded_tick_count,
    }
}

// ─── 测试(全部 #[cfg(test)],不进发布产物;与 TS fixture 互钉) ────────────────

#[cfg(test)]
mod physics_debug_compare_tests {
    use super::*;
    use serde_json::Value;

    const FIXTURE_RAW: &str = include_str!("../tests/fixtures/physics-debug-compare-v1.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE_RAW).expect("fixture JSON 解析失败")
    }

    struct FixtureReplay {
        ticks: Vec<u32>,
        hashes: Vec<String>,
        poses: Vec<Vec<f32>>,
        lanes: Vec<(u32, u32)>,
    }

    /// 重放场景(可注入单 tick 偏差),同时逐位对拍夹具位姿并复算哈希。
    fn replay(deviate_tick: Option<u32>, fixture_value: &Value) -> FixtureReplay {
        let scenario = &fixture_value["scenario"];
        let ticks_total = scenario["ticks"].as_u64().expect("fixture ticks") as u32;
        let dt = scenario["dtSeconds"].as_f64().expect("dtSeconds") as f32;
        let gravity_y = scenario["gravityY"].as_f64().expect("gravityY") as f32;
        let expected_poses = &fixture_value[if deviate_tick.is_some() {
            "deviated"
        } else {
            "expected"
        }]["poses"];
        let expected_hashes = &fixture_value[if deviate_tick.is_some() {
            "deviated"
        } else {
            "expected"
        }]["tickHashes"];
        let deviation_delta = fixture_value["deviated"]["delta"].as_f64().expect("delta") as f32;
        let mut bodies = scenario_initial_bodies();
        let mut replay = FixtureReplay {
            ticks: Vec::new(),
            hashes: Vec::new(),
            poses: Vec::new(),
            lanes: Vec::new(),
        };
        for tick in 1..=ticks_total {
            step_tick(&mut bodies, dt, gravity_y);
            let mut block = scenario_pose_block(&bodies);
            if Some(tick) == deviate_tick {
                block[0] += deviation_delta;
            }
            // 位姿逐位:夹具十进制串 → f64 → f32,与本镜像 f32 位模式全等。
            let expected_tick = expected_poses
                .as_array()
                .expect("poses 数组")
                .get((tick - 1) as usize)
                .expect("tick 位姿行");
            let expected = expected_tick.as_array().expect("位姿行数组");
            assert_eq!(expected.len(), block.len(), "tick {tick} 位姿长度不符");
            for (element, actual) in expected.iter().zip(&block) {
                let wanted = element.as_f64().expect("位姿数字") as f32;
                assert_eq!(
                    wanted.to_bits(),
                    actual.to_bits(),
                    "tick {tick} 位姿位模式漂移"
                );
            }
            let hash = pose_tick_hash(&block);
            let expected_hash = expected_hashes
                .as_array()
                .expect("tickHashes")
                .get((tick - 1) as usize)
                .expect("tick 哈希")
                .as_str()
                .expect("哈希串");
            assert_eq!(hash, expected_hash, "tick {tick} 哈希漂移");
            let (forward, backward) = fnv1a_dual_lane_f32(&block);
            replay.ticks.push(tick);
            replay.hashes.push(hash);
            replay.poses.push(block);
            replay.lanes.push((forward, backward));
        }
        replay
    }

    #[test]
    fn scenario_replays_bitwise_and_chain_hash_matches_fixture() {
        let fixture_value = fixture();
        assert_eq!(
            fixture_value["schema"].as_str(),
            Some("deep-engine.physics-debug-recording-parity")
        );
        let replay = replay(None, &fixture_value);
        let expected_chain = fixture_value["expected"]["chainHash"]
            .as_str()
            .expect("chainHash");
        assert_eq!(
            pose_chain_hash(&replay.lanes),
            expected_chain,
            "链哈希漂移:TS 产品实现哈希链未被 Rust 镜像复现"
        );
        // 场景合同自检:90 tick × 3 体 × 7 分量。
        assert_eq!(replay.ticks.len(), 90);
        assert_eq!(replay.poses[0].len(), 21);
    }

    #[test]
    fn double_run_is_bitwise_deterministic() {
        let fixture_value = fixture();
        let first = replay(None, &fixture_value);
        let second = replay(None, &fixture_value);
        assert_eq!(
            pose_chain_hash(&first.lanes),
            pose_chain_hash(&second.lanes)
        );
        assert!(
            first
                .poses
                .iter()
                .zip(&second.poses)
                .all(|(a, b)| a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits()))
        );
    }

    #[test]
    fn injected_deviated_tick_is_located_exactly() {
        let fixture_value = fixture();
        let deviated = fixture_value["deviated"].clone();
        let deviate_tick = deviated["tick"].as_u64().expect("deviated.tick") as u32;
        let deviated_run = replay(Some(deviate_tick), &fixture_value);
        // 偏差运行自身的哈希链也应与夹具 deviated.chainHash 一致(双侧同源)。
        assert_eq!(
            pose_chain_hash(&deviated_run.lanes),
            deviated["chainHash"].as_str().expect("deviated.chainHash")
        );

        let clean = replay(None, &fixture_value);
        let outcome = compare_pose_recordings(
            &PoseRecordingView {
                ticks: &clean.ticks,
                hashes: &clean.hashes,
                poses: &clean.poses,
            },
            &PoseRecordingView {
                ticks: &deviated_run.ticks,
                hashes: &deviated_run.hashes,
                poses: &deviated_run.poses,
            },
            PHYSICS_DEBUG_POSITION_TOLERANCE_METERS,
            PHYSICS_DEBUG_ROTATION_TOLERANCE_RADIANS,
        );
        assert_eq!(
            outcome.first_exceeded_tick,
            Some(deviate_tick),
            "首超差 tick 定位漂移"
        );
        assert_eq!(
            outcome.first_hash_mismatch_tick,
            Some(deviate_tick),
            "首哈希失配 tick 定位漂移"
        );
        assert_eq!(
            outcome.exceeded_tick_count, 1,
            "单 tick 注入只允许单 tick 超差"
        );
        assert_eq!(
            outcome.first_exceeded_tick,
            deviated["expectedFirstExceededTick"]
                .as_u64()
                .map(|v| v as u32)
        );
        assert_eq!(
            outcome.first_hash_mismatch_tick,
            deviated["expectedFirstHashMismatchTick"]
                .as_u64()
                .map(|v| v as u32)
        );
        assert_eq!(
            outcome.exceeded_tick_count,
            deviated["expectedExceededTickCount"].as_u64().unwrap() as usize
        );
        // 注入幅度 2e-3 = 2× 容差;测量值应落在其邻域(hypot 实现允许 ulp 级差异)。
        let expected_max = deviated["expectedMaxPosition"]
            .as_f64()
            .expect("expectedMaxPosition");
        assert!(
            (outcome.max_position - expected_max).abs() < 1e-12,
            "max_position 与 TS 侧测量漂移"
        );
        // 快路径证据:除注入 tick 外全部哈希命中。
        assert_eq!(
            outcome.rows.iter().filter(|row| row.hash_match).count(),
            outcome.rows.len() - 1
        );
    }

    #[test]
    fn sub_tolerance_deviation_reports_hash_mismatch_without_red_flag() {
        let fixture_value = fixture();
        let clean = replay(None, &fixture_value);
        // 亚容差(2e-4)偏差:哈希失配必须照报(位模式证据),1e-3 红线不误报。
        let mut bodies = scenario_initial_bodies();
        let scenario = &fixture_value["scenario"];
        let dt = scenario["dtSeconds"].as_f64().unwrap() as f32;
        let gravity_y = scenario["gravityY"].as_f64().unwrap() as f32;
        let mut ticks = Vec::new();
        let mut hashes = Vec::new();
        let mut poses = Vec::new();
        for tick in 1..=scenario["ticks"].as_u64().unwrap() as u32 {
            step_tick(&mut bodies, dt, gravity_y);
            let mut block = scenario_pose_block(&bodies);
            if tick == 20 {
                block[0] += 2e-4f32;
            }
            ticks.push(tick);
            hashes.push(pose_tick_hash(&block));
            poses.push(block);
        }
        let outcome = compare_pose_recordings(
            &PoseRecordingView {
                ticks: &clean.ticks,
                hashes: &clean.hashes,
                poses: &clean.poses,
            },
            &PoseRecordingView {
                ticks: &ticks,
                hashes: &hashes,
                poses: &poses,
            },
            PHYSICS_DEBUG_POSITION_TOLERANCE_METERS,
            PHYSICS_DEBUG_ROTATION_TOLERANCE_RADIANS,
        );
        assert_eq!(outcome.first_hash_mismatch_tick, Some(20));
        assert_eq!(outcome.first_exceeded_tick, None);
        assert_eq!(outcome.exceeded_tick_count, 0);
    }
}
