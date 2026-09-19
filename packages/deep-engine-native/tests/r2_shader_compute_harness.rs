//! R2 切片 2:Native wgpu 第三端 harness —— DCIR HiZ reduce 内核在 Native wgpu 上的
//! 三端逐位一致性认证(设计 `docs/specs/r2-shader-ir-design-2026-09-19.md` §4/§6/§7)。
//!
//! 合同(与 Web 侧已认证 kernel 生成逻辑零改动,只消费其 WGSL 工件):
//! 1. WGSL 文本 = `assets/shaders/dcir_hi_z_*.wgsl`,逐字节来自 R4 证据
//!    `test-output/r4-hiz-wiring-20260919-r1/kernels/`(R2 与 R4 的 anchored
//!    工件同哈希,已验证);CPU-only 测试断言其 sha256 与证据工件哈希一致,防复制漂移。
//! 2. 输入 = R2/R4 证据 `inputs/*.f32.bin`(真机同源,输入哈希与 evidence.inputSha256 对齐);
//!    R4 链式案例逐级以 Web 端 `.new.l(N-1)` dump 为对拍基准,链内以本端上一级输出为源
//!    (与 Web 端真实执行同口径)。
//! 3. 期望输出 = R2 `evidence.json` 的 `webgpu.outputSha256` / R4 `outputs/*.new.lN.f32.bin`
//!    实体字节 sha256(Web 端 Dawn GPU 首轮 dump;非 denormal 案例与
//!    `referenceChainSha256` 逐位一致,已交叉验证;denormal 案例与 CPU 参考链不同属
//!    FTZ 预期,以 Web 端 GPU 实体 dump 为对拍基准;perf-only 案例无 dump,取
//!    `referenceChainSha256`——R4 门已证 Web GPU 链与 CPU 参考逐位一致)。
//! 4. 判定:非 denormal 案例逐位档(bitwise)必须通过,失败即 panic;denormal 案例为
//!    阈值档风险探针,如实记录 Native 与 Web 端 GPU 的一致性,不一致不阻断证据产出。
//! 5. 每案例跑两轮验证 Native 端重复稳定性;输出 dump 落
//!    `test-output/r2-native-third-end-20260919-r1/outputs/`,证据汇总写同目录 `evidence.json`
//!    (对拍与性能在同一测试内顺序完成,避免并行竞写)。
//! 6. 性能:GPU timestamp 包夹单 encoder 全链 repeats(无 CPU 同步混入,与 Web 端
//!    Dawn 脚本口径一致),`queue.get_timestamp_period()` 校准绝对 ns;与 Web 端
//!    ratio 口径分开,只记绝对微秒级量级。
//!
//! 运行(需要真机 GPU,与既有 GPU 测试同为显式运行):
//! `cargo test -p deep-engine-native --test r2_shader_compute_harness -- --ignored --nocapture`
//! 证据输入缺失时按提示先重跑 Web 端脚本(test:r4-hiz-wiring-gpu / test:r2-shader-ir-gpu)。

#[path = "../src/shader_package/hash.rs"]
mod sha256_impl;
#[path = "support/r2_hiz_native_wgpu.rs"]
mod native_wgpu;

use native_wgpu::{
    iso8601_utc, map_read_buffer, now_unix_ms, read_evidence_input, evidence_root, Kind, Mode,
    NativeHarness, ReduceLevel, WGSL_ANCHORED_MAX, WGSL_ANCHORED_MIN, WGSL_SHA_ANCHORED_MAX,
    WGSL_SHA_ANCHORED_MIN, WGSL_SHA_VARIABLE_MAX, WGSL_SHA_VARIABLE_MIN, WGSL_VARIABLE_MAX,
    WGSL_VARIABLE_MIN,
};
use sha256_impl::sha256;
use wgpu::util::DeviceExt;

// ---------------------------------------------------------------------------
// 案例黄金表(2026-09-19 RTX 4060 Laptop 真机证据,来源见各结构注释)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tier {
    /// 逐位档判定必须通过。
    Bitwise,
    /// denormal 阈值档风险探针:记录一致性,不参与逐位判定(设计 §4.4)。
    DenormalProbe,
}

/// R2 单级案例:期望 = `r2-shader-ir-20260919-r1/evidence.json` webgpu.outputSha256。
struct R2Case {
    name: &'static str,
    src: [u32; 2],
    dst: [u32; 2],
    mode: Mode,
    expected: &'static str,
    tier: Tier,
}

const R2_CASES: &[R2Case] = &[
    R2Case { name: "pow2-64x64-min", src: [64, 64], dst: [32, 32], mode: Mode::Min, expected: "9963cd9356422e47087c2587b087acb51777c71cb57a6d5f6900faefb81ab31b", tier: Tier::Bitwise },
    R2Case { name: "npot-37x23-min", src: [37, 23], dst: [19, 12], mode: Mode::Min, expected: "3d9154fca88b3b59ce853a9db0eaafee19e71b2e408995774aa695c233b36397", tier: Tier::Bitwise },
    R2Case { name: "npot-13x7-max", src: [13, 7], dst: [7, 4], mode: Mode::Max, expected: "30fab50e597723aaacfc9201acf943eb1bbbc38e81d08f7de51d2d51ab1842f3", tier: Tier::Bitwise },
    R2Case { name: "tiny-1x1-min", src: [1, 1], dst: [1, 1], mode: Mode::Min, expected: "ec16d2246284c1fb1f97d50e5dcc13e9340c50b28007607e36dd857ba668b905", tier: Tier::Bitwise },
    R2Case { name: "denormal-17x9-min", src: [17, 9], dst: [9, 5], mode: Mode::Min, expected: "10b2a66888c58a54b277fe2e68fb6e87150c3cd2c537b7f6a2d84559017438c7", tier: Tier::DenormalProbe },
];

/// R4 链式案例:期望 = `r4-hiz-wiring-20260919-r1/outputs/*.new.lN.f32.bin` 实体字节
/// sha256(Web 端 Dawn GPU dump;perf-only 案例无 dump,取 evidence.referenceChainSha256,
/// R4 门已证 Web GPU 链与其逐位一致)。chain[0] 为输入哈希,chain[n] 为第 n 级期望。
struct R4Case {
    name: &'static str,
    mode: Mode,
    tier: Tier,
    levels: &'static [ReduceLevel],
    chain: &'static [&'static str],
}

const R4_CASES: &[R4Case] = &[
    R4Case {
        name: "even-64x64-min",
        mode: Mode::Min,
        tier: Tier::Bitwise,
        levels: &[
            ReduceLevel { src: [64, 64], dst: [32, 32], kind: Kind::Anchored },
            ReduceLevel { src: [32, 32], dst: [16, 16], kind: Kind::Anchored },
            ReduceLevel { src: [16, 16], dst: [8, 8], kind: Kind::Anchored },
            ReduceLevel { src: [8, 8], dst: [4, 4], kind: Kind::Anchored },
            ReduceLevel { src: [4, 4], dst: [2, 2], kind: Kind::Anchored },
            ReduceLevel { src: [2, 2], dst: [1, 1], kind: Kind::Anchored },
        ],
        chain: &[
            "e04233b5483896ae7d49e33ff87910efe529194b5d4fb669c06cbf00a6a9c5e2",
            "1323a1e3fa14d9b1692dd90dde422a223250434e4b827972eec17a4c10fbeae4",
            "e21161996bba6743d209f9f03c74cb51d882b328584b0985a7d7b7f397b0ddc7",
            "4688f2365d3f67268ab381d9ecd75ec19a6b40cd0e39f6ae8719bae33166fe1a",
            "95ff333ba4f857212a267d7df212764a7deac6dba9bedaf6dc91fc47495aa71d",
            "69e2c20890bee1c1055b0b0fd9d413d3f2efe4dcaf42bb926db3ab30c38ff86f",
            "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
        ],
    },
    R4Case {
        name: "even-16x16-max",
        mode: Mode::Max,
        tier: Tier::Bitwise,
        levels: &[
            ReduceLevel { src: [16, 16], dst: [8, 8], kind: Kind::Anchored },
            ReduceLevel { src: [8, 8], dst: [4, 4], kind: Kind::Anchored },
            ReduceLevel { src: [4, 4], dst: [2, 2], kind: Kind::Anchored },
            ReduceLevel { src: [2, 2], dst: [1, 1], kind: Kind::Anchored },
        ],
        chain: &[
            "ee763d2e22d7aa2b939528b20d658f5928ed97f91aa131bd98d1df791ee81786",
            "f3a96772737a79523d3003dcf217f679b9fba5213a345cb9b28a805c752a13d9",
            "7a6f18b1d0da8af129fe328dc51d3fc7b6a1f0074d751bc7a0ef613c41242261",
            "c48976d776244401ba76eba7551b82cb5f55a84e0f74e9e88026b9e8999a620c",
            "d7173dd8a9e81deded3f2e4719ef149effbd21afd81da9d10ed50b5dff69a708",
        ],
    },
    R4Case {
        name: "npot-37x23-max",
        mode: Mode::Max,
        tier: Tier::Bitwise,
        levels: &[
            ReduceLevel { src: [37, 23], dst: [18, 11], kind: Kind::Variable },
            ReduceLevel { src: [18, 11], dst: [9, 5], kind: Kind::Variable },
            ReduceLevel { src: [9, 5], dst: [4, 2], kind: Kind::Variable },
            ReduceLevel { src: [4, 2], dst: [2, 1], kind: Kind::Anchored },
            ReduceLevel { src: [2, 1], dst: [1, 1], kind: Kind::Variable },
        ],
        chain: &[
            "3547eb728d8563d29008bf3b46ea6c7969c76e54efd3167071ee5b1adacfffd7",
            "c9c0e663c53300848aad406d875537e7cf4013faaf705101385f905ded6509d9",
            "74acd458057b9f2d7d1bea946e46d682936dec06cd4334f41818a99d712aeaa4",
            "7a2f617e39c67c9eef55909605327a7f7e8d9c7ef77ed04918db77362852cf74",
            "be51aaa387ea3e0f4ca78be6fdb0b50fa98cfda881ee1e7936c5ce22c2927f9e",
            "d7173dd8a9e81deded3f2e4719ef149effbd21afd81da9d10ed50b5dff69a708",
        ],
    },
    R4Case {
        name: "npot-13x7-min",
        mode: Mode::Min,
        tier: Tier::Bitwise,
        levels: &[
            ReduceLevel { src: [13, 7], dst: [6, 3], kind: Kind::Variable },
            ReduceLevel { src: [6, 3], dst: [3, 1], kind: Kind::Variable },
            ReduceLevel { src: [3, 1], dst: [1, 1], kind: Kind::Variable },
        ],
        chain: &[
            "a682d5fa1ab52e3c6df83d3e7f30fc271627276e7c6ed1671b4f4bcb74557da0",
            "f80280344b46d6e9473d47c1797b19028ce812d99df4d0a30ee7d4a3d11e1cd5",
            "6d56a5644637eb1cc7f3478f4fed870ac105afdad1a61ef124864a6dc7cfb4fc",
            "90c0ee445609f1db6d43cf394f1d912118e47c39ea42162510a58f805bf39cac",
        ],
    },
    R4Case {
        name: "mixed-48x37-max",
        mode: Mode::Max,
        tier: Tier::Bitwise,
        levels: &[
            ReduceLevel { src: [48, 37], dst: [24, 18], kind: Kind::Variable },
            ReduceLevel { src: [24, 18], dst: [12, 9], kind: Kind::Anchored },
            ReduceLevel { src: [12, 9], dst: [6, 4], kind: Kind::Variable },
            ReduceLevel { src: [6, 4], dst: [3, 2], kind: Kind::Anchored },
            ReduceLevel { src: [3, 2], dst: [1, 1], kind: Kind::Variable },
        ],
        chain: &[
            "8fee2dadbaebd8a838923f350ebedbc2aa8b6e674b098d8665647ae3671888bb",
            "718e8568a7e06109fd851eebc54650cc7ebbe5955b8a4c7565a15ce392e4fe73",
            "4359984b61cfbcf579eb0e33bd61985ace907a34ed7308ed8a6a4e4ac5061ea9",
            "47ddad309814b58ff9ff8e21069481e74674872bc6c23479423cde16c64e7013",
            "d1f51b5c17343b49c2a8ac0773f22244245e9ceb0ce34e4360ff7c90c2d45e88",
            "d7173dd8a9e81deded3f2e4719ef149effbd21afd81da9d10ed50b5dff69a708",
        ],
    },
    R4Case {
        name: "tiny-2x1-min",
        mode: Mode::Min,
        tier: Tier::Bitwise,
        levels: &[ReduceLevel { src: [2, 1], dst: [1, 1], kind: Kind::Variable }],
        chain: &[
            "fe4d7b2f92026589bef414491c43733b4ed3ffa8ae2f02509268ca9791db50d1",
            "d170e4953bc3f7b7c0d0a8ad36101857bbc9563b3262d62c2e0870a059bc43af",
        ],
    },
    R4Case {
        name: "tiny-1x1-min",
        mode: Mode::Min,
        tier: Tier::Bitwise,
        levels: &[],
        chain: &["5f6c08fee30e034232e7bdeeff0dc09620bc632f91c4df4abafead410599b61c"],
    },
    R4Case {
        name: "perf-512x512-max",
        mode: Mode::Max,
        tier: Tier::Bitwise,
        levels: &[
            ReduceLevel { src: [512, 512], dst: [256, 256], kind: Kind::Anchored },
            ReduceLevel { src: [256, 256], dst: [128, 128], kind: Kind::Anchored },
            ReduceLevel { src: [128, 128], dst: [64, 64], kind: Kind::Anchored },
            ReduceLevel { src: [64, 64], dst: [32, 32], kind: Kind::Anchored },
            ReduceLevel { src: [32, 32], dst: [16, 16], kind: Kind::Anchored },
            ReduceLevel { src: [16, 16], dst: [8, 8], kind: Kind::Anchored },
            ReduceLevel { src: [8, 8], dst: [4, 4], kind: Kind::Anchored },
            ReduceLevel { src: [4, 4], dst: [2, 2], kind: Kind::Anchored },
            ReduceLevel { src: [2, 2], dst: [1, 1], kind: Kind::Anchored },
        ],
        chain: &[
            "6fa747fb747747387914ce991de910f58c83a4e7f77ec90cdcf418a91a624988",
            "95a832f1f394376179764370497366506b70c6c38f696bef58c33a37b90f0d7b",
            "7325a65a62ffe2bc8c6f5d52c59a13ee1596c76d1b4bb809c790b026c9b68044",
            "43eb6ef180f9b9843183e3ee25d87319eb4865fddcad5c705148a9148406ea18",
            "2983a5d951c5f15fdc3ccade7255ffe96c0948b1cdb575ae3d09617e06532f98",
            "ecc4c62dd124a13e9bd08a8a6ce12834c7cc201c031f6d38fc87d20a46e4f7f4",
            "9660cf90f794bcd629ef6f8b24e3879aa67ef09478d772258f7960908f9a34d2",
            "680d86160fd0541ff7456e9bbf677bb90137a22ce326a9bd143c4058d36b3ffa",
            "672841d7f94bca1fdf3ba4c0c9f25518239972ea1d441b82735583dca9df698b",
            "6af5d2898a34e0435ab79e263d3756dc70e00ae3fe90fa2daf43b62117615df8",
        ],
    },
    R4Case {
        name: "perf-odd-639x479-min",
        mode: Mode::Min,
        tier: Tier::Bitwise,
        levels: &[
            ReduceLevel { src: [639, 479], dst: [319, 239], kind: Kind::Variable },
            ReduceLevel { src: [319, 239], dst: [159, 119], kind: Kind::Variable },
            ReduceLevel { src: [159, 119], dst: [79, 59], kind: Kind::Variable },
            ReduceLevel { src: [79, 59], dst: [39, 29], kind: Kind::Variable },
            ReduceLevel { src: [39, 29], dst: [19, 14], kind: Kind::Variable },
            ReduceLevel { src: [19, 14], dst: [9, 7], kind: Kind::Variable },
            ReduceLevel { src: [9, 7], dst: [4, 3], kind: Kind::Variable },
            ReduceLevel { src: [4, 3], dst: [2, 1], kind: Kind::Variable },
            ReduceLevel { src: [2, 1], dst: [1, 1], kind: Kind::Variable },
        ],
        chain: &[
            "9856691ff59732b6826ab8f969e5e5015c0c781241bcc766362b8cd183ae1322",
            "d2c68e085406c52b4508d857789dc7aa7a49269d4647c5f4b652021422feec16",
            "2b513317262254b84a0ba6316bf76d32fd27599420928674ec9a926f80173cc6",
            "9b1c3064e69d44fcef0ae4e77a2049de03ccb264294f6cb66f5a4b121d3f4e67",
            "718842713cc598f2ce3de573f5e7eae547819a69e231844cb1fb8141fa6a8005",
            "f11c195647299ad3f50e30d00d66ac8ea0bd257c09ed58d0b48db2969f62d1b6",
            "d9259f47d5b64d96ac461649182b3fbb737eb18435c28d37c006ecbe317d4ddd",
            "d058e3af900737291f24f79fdc7bc527f940f2422c1f8f66794bbea1e1bbe693",
            "f40ac0c06975f97b5ce20c3ae799c3a4379f97285c5200e1f2d70e1190336ff8",
            "e698ec253c7c0a1f48eb354a8b0650a14b3ff290ef0eb548fa6d2f1cadf631d8",
        ],
    },
    R4Case {
        name: "denormal-17x9-min",
        mode: Mode::Min,
        tier: Tier::DenormalProbe,
        levels: &[
            ReduceLevel { src: [17, 9], dst: [8, 4], kind: Kind::Variable },
            ReduceLevel { src: [8, 4], dst: [4, 2], kind: Kind::Anchored },
            ReduceLevel { src: [4, 2], dst: [2, 1], kind: Kind::Anchored },
            ReduceLevel { src: [2, 1], dst: [1, 1], kind: Kind::Variable },
        ],
        chain: &[
            "5ebe05b8f0f66939f753ab0d42be78b9637b894ed565eb4f7c04c824b51c790a",
            "38723a2e5e8a17aa7950dc008209944e898f69a7bd10a23c839d341e935fd5ca",
            "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
            "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
            "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
        ],
    },
];

// ---------------------------------------------------------------------------
// 测试 1:工件完整性(CPU-only,CI 可跑)
// ---------------------------------------------------------------------------

#[test]
fn dcir_wgsl_artifacts_match_evidence_hashes() {
    for (text, expected, label) in [
        (WGSL_ANCHORED_MIN, WGSL_SHA_ANCHORED_MIN, "anchored min"),
        (WGSL_ANCHORED_MAX, WGSL_SHA_ANCHORED_MAX, "anchored max"),
        (WGSL_VARIABLE_MIN, WGSL_SHA_VARIABLE_MIN, "variable min"),
        (WGSL_VARIABLE_MAX, WGSL_SHA_VARIABLE_MAX, "variable max"),
    ] {
        assert_eq!(sha256(text.as_bytes()), expected, "{label} wgsl drift");
    }
}

/// 黄金表自洽性:尺寸合同(R2 ceil 口径 / R4 GPU mip floor 链)、链式衔接与 kernel
/// 分派(偶×偶源 → anchored)不因手抄而漂移。
#[test]
fn evidence_golden_tables_are_self_consistent() {
    for case in R2_CASES {
        assert_eq!(
            case.dst,
            [case.src[0].div_ceil(2), case.src[1].div_ceil(2)],
            "R2 {} must use ceil target size",
            case.name
        );
    }
    for case in R4_CASES {
        assert_eq!(case.chain.len(), case.levels.len() + 1, "{} chain length", case.name);
        for (index, level) in case.levels.iter().enumerate() {
            assert_eq!(
                level.dst,
                [1.max(level.src[0] / 2), 1.max(level.src[1] / 2)],
                "{} level {} must use GPU mip floor chain",
                case.name,
                index + 1
            );
            if index > 0 {
                assert_eq!(
                    level.src, case.levels[index - 1].dst,
                    "{} level {} must chain from previous target",
                    case.name, index + 1
                );
            }
            assert_eq!(
                level.kind == Kind::Anchored,
                level.src[0] % 2 == 0 && level.src[1] % 2 == 0,
                "{} level {} kernel dispatch must match even×even rule",
                case.name,
                index + 1
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 测试 2:三端逐位一致认证 + 性能粗账(GPU,显式运行)
// ---------------------------------------------------------------------------

#[test]
#[ignore = "requires the RTX evidence GPU and test-output inputs; run explicitly with --ignored"]
fn native_wgpu_hiz_reduce_third_end_certification() {
    let harness = NativeHarness::new();
    println!(
        "adapter: {} vendor=0x{:04x} backend={:?} timestamp_period={}ns",
        harness.info.name, harness.info.vendor, harness.info.backend, harness.timestamp_period_ns
    );
    let root = evidence_root();
    let out_dir = root.join("r2-native-third-end-20260919-r1/outputs");
    std::fs::create_dir_all(&out_dir).expect("create evidence outputs dir");
    let mut case_records = Vec::new();

    // —— R2 单级案例(anchored kernel,R2 ceil 口径)——
    for case in R2_CASES {
        let input = read_evidence_input(&root, "r2-shader-ir-20260919-r1", case.name);
        let level = ReduceLevel { src: case.src, dst: case.dst, kind: Kind::Anchored };
        let round1 = harness.run_reduce(&level, case.mode, &input);
        let round2 = harness.run_reduce(&level, case.mode, &input);
        let sha1 = sha256(&round1);
        let sha2 = sha256(&round2);
        let repeat_stable = sha1 == sha2;
        let matches_web = sha1 == case.expected;
        assert!(repeat_stable, "{}: native rounds diverged ({sha1} vs {sha2})", case.name);
        std::fs::write(out_dir.join(format!("{}.native.f32.bin", case.name)), &round1)
            .expect("write native dump");
        println!(
            "R2 {}: native={sha1} webgpu={} repeatStable={repeat_stable} bitwiseMatch={matches_web}",
            case.name, case.expected
        );
        if case.tier == Tier::Bitwise {
            assert!(
                matches_web,
                "{}: Native wgpu output diverges from WebGPU evidence (bitwise tier)",
                case.name
            );
        }
        case_records.push(serde_json::json!({
            "name": case.name,
            "evidenceSet": "r2-shader-ir-20260919-r1",
            "tier": tier_label(case.tier),
            "mode": case.mode.label(),
            "kernel": "hi_z_first_stage",
            "kernelWgslSha256": case.mode.sha(Kind::Anchored),
            "sourceSize": case.src,
            "targetSize": case.dst,
            "nativeRound1Sha256": sha1,
            "nativeRound2Sha256": sha2,
            "repeatStable": repeat_stable,
            "webgpuSha256": case.expected,
            "bitwiseMatchVsWebgpu": matches_web,
            "dump": format!("outputs/{}.native.f32.bin", case.name),
        }));
        harness.assert_no_gpu_errors(case.name);
    }

    // —— R4 链式案例(anchored + variable,GPU mip floor 链口径)——
    for case in R4_CASES {
        if case.levels.is_empty() {
            continue; // tiny-1x1:无 reduce 级,输入即终点
        }
        let input = read_evidence_input(&root, "r4-hiz-wiring-20260919-r1", case.name);
        assert_eq!(sha256(&input), case.chain[0], "{} input drift vs evidence", case.name);
        let rounds = [
            harness.run_chain(case.mode, case.levels, &input),
            harness.run_chain(case.mode, case.levels, &input),
        ];
        let mut level_records = Vec::with_capacity(case.levels.len());
        for (index, output) in rounds[0].iter().enumerate() {
            let sha1 = sha256(output);
            let sha2 = sha256(&rounds[1][index]);
            let repeat_stable = sha1 == sha2;
            let matches_web = sha1 == case.chain[index + 1];
            assert!(repeat_stable, "{} l{}: native rounds diverged", case.name, index + 1);
            std::fs::write(
                out_dir.join(format!("{}.native.l{}.f32.bin", case.name, index + 1)),
                output,
            )
            .expect("write native dump");
            println!(
                "R4 {} l{}({:?}→{:?} {}): native={sha1} web={} repeatStable={repeat_stable} match={matches_web}",
                case.name,
                index + 1,
                case.levels[index].src,
                case.levels[index].dst,
                case.levels[index].kind.label(),
                case.chain[index + 1]
            );
            if case.tier == Tier::Bitwise {
                assert!(
                    matches_web,
                    "{} level {}: Native wgpu diverges from Web GPU evidence (bitwise tier)",
                    case.name,
                    index + 1
                );
            }
            level_records.push(serde_json::json!({
                "level": index + 1,
                "sourceSize": case.levels[index].src,
                "targetSize": case.levels[index].dst,
                "kernel": case.levels[index].kind.label(),
                "kernelWgslSha256": case.mode.sha(case.levels[index].kind),
                "nativeRound1Sha256": sha1,
                "nativeRound2Sha256": sha2,
                "repeatStable": repeat_stable,
                "webgpuSha256": case.chain[index + 1],
                "bitwiseMatchVsWebgpu": matches_web,
                "dump": format!("outputs/{}.native.l{}.f32.bin", case.name, index + 1),
            }));
        }
        harness.assert_no_gpu_errors(case.name);
        case_records.push(serde_json::json!({
            "name": case.name,
            "evidenceSet": "r4-hiz-wiring-20260919-r1",
            "tier": tier_label(case.tier),
            "mode": case.mode.label(),
            "inputSha256": case.chain[0],
            "levels": level_records,
        }));
    }

    // —— 性能粗账:单 encoder 全链 repeats + timestamp 包夹(无 CPU 同步混入)——
    let perf_records = measure_perf(&harness, &root);

    // —— 证据汇总 ——
    let denormal_consistent = case_records.iter().filter(|record| record["tier"] == "denormal-probe").all(|record| match record["levels"].as_array() {
        Some(levels) => levels.iter().all(|level| level["bitwiseMatchVsWebgpu"] == true),
        None => record["bitwiseMatchVsWebgpu"] == true,
    });
    let bitwise = case_records
        .iter()
        .filter(|record| record["tier"] == "bitwise")
        .count();
    let evidence = serde_json::json!({
        "schema": "r2-native-third-end-evidence-v1",
        "lane": "R2",
        "createdAt": iso8601_utc(now_unix_ms()),
        "kernelArtifacts": {
            "note": "WGSL 文本逐字节复制自 R4 证据 kernels/(R2 与 R4 anchored 工件同哈希已验证);加载方式变化不改变 shader 文本。",
            "wgsl": {
                "anchoredMin": { "sha256": WGSL_SHA_ANCHORED_MIN, "entryPoint": "hi_z_first_stage" },
                "anchoredMax": { "sha256": WGSL_SHA_ANCHORED_MAX, "entryPoint": "hi_z_first_stage" },
                "variableMin": { "sha256": WGSL_SHA_VARIABLE_MIN, "entryPoint": "hi_z_variable_reduce" },
                "variableMax": { "sha256": WGSL_SHA_VARIABLE_MAX, "entryPoint": "hi_z_variable_reduce" }
            }
        },
        "environment": {
            "adapter": {
                "name": harness.info.name,
                "vendor": format!("0x{:04x}", harness.info.vendor),
                "device": format!("0x{:04x}", harness.info.device),
                "backend": format!("{:?}", harness.info.backend),
                "driver": harness.info.driver,
                "driverInfo": harness.info.driver_info,
            },
            "wgpuVersion": "30.0.1",
            "timestampPeriodNs": harness.timestamp_period_ns,
            "uniformBufferBytes": 16,
            "readbackBytesPerRowAlignment": 256,
            "notes": [
                "uniform 实际 16 字节(uvec2 sourceSize + uvec2 targetSize);reduceMax 已在 IR 层特化为 min/max 双工件。",
                "Web 端对照:Chrome 153 headless,Dawn/D3D11,RTX 4060 Laptop(r2-shader-ir-20260919-r1 与 r4-hiz-wiring-20260919-r1 evidence.json)。",
                "R4 期望哈希来源:bitwise 案例取 outputs/*.new.lN 实体 dump(=CPU 参考链,已交叉验证);denormal 案例取 GPU dump(与 CPU 参考链 FTZ 差异属预期);perf 案例无 dump,取 referenceChainSha256(R4 门已证 Web GPU 链与之逐位一致)。",
            ]
        },
        "cases": case_records,
        "perf": {
            "method": "GPU timestamp queries (encoder.write_timestamp) 包夹单 encoder 全链 repeats,无 CPU 同步混入;绝对 ns 经 queue.get_timestamp_period() 校准",
            "timestampPeriodNs": harness.timestamp_period_ns,
            "timestampPeriodCaveat": "period 来自 wgpu 队列报告值;与 Web 端 Dawn 的 ratio 口径(周期不可得)分开,仅记绝对微秒级量级。",
            "cases": perf_records,
        },
        "denormal": {
            "tier": "denormal-probe",
            "nativeMatchesWebGpu": denormal_consistent,
            "note": "wgpu(Native)与 Dawn(Web)同 NVIDIA 驱动栈,FTZ 行为预期一致;若不一致即为发现,以本字段与案例哈希如实记录。",
        },
        "verdict": {
            "bitwiseCaseCount": bitwise,
            "nativeVsWebgpuBitwise": true,
            "repeatStable": true,
            "note": "逐位档案例 Native 与 Web 端 GPU 输出哈希逐位一致;denormal 案例为阈值档探针,不参与逐位判定(设计 §4.4)。",
        },
    });
    let evidence_path = root.join("r2-native-third-end-20260919-r1/evidence.json");
    std::fs::create_dir_all(evidence_path.parent().unwrap()).expect("create evidence dir");
    std::fs::write(&evidence_path, serde_json::to_string_pretty(&evidence).unwrap())
        .expect("write evidence.json");
    println!("evidence written: {}", evidence_path.display());
}

fn tier_label(tier: Tier) -> &'static str {
    match tier {
        Tier::Bitwise => "bitwise",
        Tier::DenormalProbe => "denormal-probe",
    }
}

/// 性能粗账:全链 encode 在单个 encoder(timestamp 包夹,无逐级 poll),
/// 纹理链预建(level N 输出即 level N+1 源,跨 pass 由 wgpu 插入 barrier)。
/// 首 sample 预热丢弃,取中位;每链最终输出哈希复核逐位正确性。
fn measure_perf(harness: &NativeHarness, root: &std::path::Path) -> Vec<serde_json::Value> {
    let query_set = harness.device.create_query_set(&wgpu::QuerySetDescriptor {
        label: Some("R2 native perf timestamps"),
        ty: wgpu::QueryType::Timestamp,
        count: 2,
    });
    let resolve = harness.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("R2 native perf resolve"),
        size: 512,
        usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let map_buffer = harness.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("R2 native perf map"),
        size: 512,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut perf_records = Vec::new();
    for case in R4_CASES.iter().filter(|case| case.name.starts_with("perf-")) {
        let input = read_evidence_input(root, "r4-hiz-wiring-20260919-r1", case.name);
        assert_eq!(sha256(&input), case.chain[0], "{} input drift", case.name);
        let chain_repeats = if case.name == "perf-512x512-max" { 16 } else { 12 };
        // 预建(非计时区):上传 buffer + 全链纹理 + per-level uniform/bind group。
        let upload_row = native_wgpu::align256(case.levels[0].src[0] as usize * 4);
        let mut upload = vec![0_u8; upload_row * case.levels[0].src[1] as usize];
        for y in 0..case.levels[0].src[1] as usize {
            upload[y * upload_row..y * upload_row + case.levels[0].src[0] as usize * 4].copy_from_slice(
                &input[y * case.levels[0].src[0] as usize * 4..(y + 1) * case.levels[0].src[0] as usize * 4],
            );
        }
        let upload_buffer = harness
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("DCIR HiZ perf upload"),
                contents: &upload,
                usage: wgpu::BufferUsages::COPY_SRC,
            });
        let textures: Vec<wgpu::Texture> = std::iter::once(case.levels[0].src)
            .chain(case.levels.iter().map(|level| level.dst))
            .map(|[w, h]| harness.create_reduce_texture(w as usize, h as usize, "DCIR HiZ perf chain texture"))
            .collect();
        let uniforms: Vec<wgpu::Buffer> = case
            .levels
            .iter()
            .map(|level| {
                harness
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("DCIR HiZ perf uniforms"),
                        contents: bytemuck::cast_slice(&[
                            level.src[0], level.src[1], level.dst[0], level.dst[1],
                        ]),
                        usage: wgpu::BufferUsages::UNIFORM,
                    })
            })
            .collect();
        let bind_groups: Vec<wgpu::BindGroup> = case
            .levels
            .iter()
            .enumerate()
            .map(|(index, level)| {
                harness.bind_reduce(
                    harness.pipeline(level.kind, case.mode),
                    &textures[index],
                    &textures[index + 1],
                    &uniforms[index],
                )
            })
            .collect();
        let final_texture = textures[textures.len() - 1].clone();
        let readback_row = native_wgpu::align256(case.levels[case.levels.len() - 1].dst[0] as usize * 4);
        let final_extent = case.levels[case.levels.len() - 1].dst;
        let readback = harness.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("DCIR HiZ perf readback"),
            size: (readback_row * final_extent[1] as usize) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut samples_ns = Vec::new();
        let mut final_sha = String::new();
        for sample in 0..5 {
            let mut encoder = harness
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("R2 native perf chain"),
                });
            encoder.write_timestamp(&query_set, 0);
            for _ in 0..chain_repeats {
                encoder.copy_buffer_to_texture(
                    wgpu::TexelCopyBufferInfo {
                        buffer: &upload_buffer,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(upload_row as u32),
                            rows_per_image: Some(case.levels[0].src[1]),
                        },
                    },
                    textures[0].as_image_copy(),
                    wgpu::Extent3d {
                        width: case.levels[0].src[0],
                        height: case.levels[0].src[1],
                        depth_or_array_layers: 1,
                    },
                );
                for (index, level) in case.levels.iter().enumerate() {
                    harness.encode_dispatch(&mut encoder, level, case.mode, &bind_groups[index]);
                }
            }
            encoder.write_timestamp(&query_set, 1);
            encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
            encoder.copy_buffer_to_buffer(&resolve, 0, &map_buffer, 0, native_wgpu::TIMESTAMP_BYTES);
            encoder.copy_texture_to_buffer(
                final_texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &readback,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(readback_row as u32),
                        rows_per_image: Some(final_extent[1]),
                    },
                },
                wgpu::Extent3d {
                    width: final_extent[0],
                    height: final_extent[1],
                    depth_or_array_layers: 1,
                },
            );
            harness.submit_and_wait(encoder, "perf chain");
            let ticks: [u64; 2] = {
                let bytes = map_read_buffer(&harness.device, &map_buffer, 16);
                map_buffer.unmap();
                bytemuck::cast_slice(&bytes).try_into().expect("2 timestamps")
            };
            let ticks_per_chain = ticks[1].wrapping_sub(ticks[0]) as f64 / chain_repeats as f64;
            samples_ns.push(ticks_per_chain * f64::from(harness.timestamp_period_ns));
            if sample == 4 {
                let raw = map_read_buffer(&harness.device, &readback, readback_row * final_extent[1] as usize);
                readback.unmap();
                let fw = final_extent[0] as usize;
                let mut bytes = Vec::with_capacity(fw * final_extent[1] as usize * 4);
                for y in 0..final_extent[1] as usize {
                    bytes.extend_from_slice(&raw[y * readback_row..y * readback_row + fw * 4]);
                }
                final_sha = sha256(&bytes);
            }
        }
        samples_ns.remove(0); // 首 sample 预热(着色器/管线冷缓存)不计入
        samples_ns.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median_ns = samples_ns[samples_ns.len() / 2];
        let per_level_us = median_ns / 1_000.0 / case.levels.len() as f64;
        println!(
            "perf {} ({} levels, {} chain repeats/sample): median={median_ns:.0}ns/chain ({:.1}us/chain, {per_level_us:.2}us/level) finalSha={final_sha}",
            case.name,
            case.levels.len(),
            chain_repeats,
            median_ns / 1_000.0,
        );
        harness.assert_no_gpu_errors(case.name);
        assert_eq!(
            final_sha,
            case.chain[case.chain.len() - 1],
            "{} perf chain must remain bitwise correct",
            case.name
        );        perf_records.push(serde_json::json!({
            "case": case.name,
            "levels": case.levels.len(),
            "chainRepeats": chain_repeats,
            "samples": samples_ns.len(),
            "firstSampleDiscardedAsWarmup": true,
            "medianNsPerChain": median_ns,
            "perLevelUs": per_level_us,
            "finalChainSha256": final_sha,
            "finalChainExpectedSha256": case.chain[case.chain.len() - 1],
        }));
    }
    perf_records
}
