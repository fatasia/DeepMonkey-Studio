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
    R2Case {
        name: "pow2-64x64-min",
        src: [64, 64],
        dst: [32, 32],
        mode: Mode::Min,
        expected: "9963cd9356422e47087c2587b087acb51777c71cb57a6d5f6900faefb81ab31b",
        tier: Tier::Bitwise,
    },
    R2Case {
        name: "npot-37x23-min",
        src: [37, 23],
        dst: [19, 12],
        mode: Mode::Min,
        expected: "3d9154fca88b3b59ce853a9db0eaafee19e71b2e408995774aa695c233b36397",
        tier: Tier::Bitwise,
    },
    R2Case {
        name: "npot-13x7-max",
        src: [13, 7],
        dst: [7, 4],
        mode: Mode::Max,
        expected: "30fab50e597723aaacfc9201acf943eb1bbbc38e81d08f7de51d2d51ab1842f3",
        tier: Tier::Bitwise,
    },
    R2Case {
        name: "tiny-1x1-min",
        src: [1, 1],
        dst: [1, 1],
        mode: Mode::Min,
        expected: "ec16d2246284c1fb1f97d50e5dcc13e9340c50b28007607e36dd857ba668b905",
        tier: Tier::Bitwise,
    },
    R2Case {
        name: "denormal-17x9-min",
        src: [17, 9],
        dst: [9, 5],
        mode: Mode::Min,
        expected: "10b2a66888c58a54b277fe2e68fb6e87150c3cd2c537b7f6a2d84559017438c7",
        tier: Tier::DenormalProbe,
    },
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
            ReduceLevel {
                src: [64, 64],
                dst: [32, 32],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [32, 32],
                dst: [16, 16],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [16, 16],
                dst: [8, 8],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [8, 8],
                dst: [4, 4],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [4, 4],
                dst: [2, 2],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [2, 2],
                dst: [1, 1],
                kind: Kind::Anchored,
            },
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
            ReduceLevel {
                src: [16, 16],
                dst: [8, 8],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [8, 8],
                dst: [4, 4],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [4, 4],
                dst: [2, 2],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [2, 2],
                dst: [1, 1],
                kind: Kind::Anchored,
            },
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
            ReduceLevel {
                src: [37, 23],
                dst: [18, 11],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [18, 11],
                dst: [9, 5],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [9, 5],
                dst: [4, 2],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [4, 2],
                dst: [2, 1],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [2, 1],
                dst: [1, 1],
                kind: Kind::Variable,
            },
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
            ReduceLevel {
                src: [13, 7],
                dst: [6, 3],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [6, 3],
                dst: [3, 1],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [3, 1],
                dst: [1, 1],
                kind: Kind::Variable,
            },
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
            ReduceLevel {
                src: [48, 37],
                dst: [24, 18],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [24, 18],
                dst: [12, 9],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [12, 9],
                dst: [6, 4],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [6, 4],
                dst: [3, 2],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [3, 2],
                dst: [1, 1],
                kind: Kind::Variable,
            },
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
        levels: &[ReduceLevel {
            src: [2, 1],
            dst: [1, 1],
            kind: Kind::Variable,
        }],
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
            ReduceLevel {
                src: [512, 512],
                dst: [256, 256],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [256, 256],
                dst: [128, 128],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [128, 128],
                dst: [64, 64],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [64, 64],
                dst: [32, 32],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [32, 32],
                dst: [16, 16],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [16, 16],
                dst: [8, 8],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [8, 8],
                dst: [4, 4],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [4, 4],
                dst: [2, 2],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [2, 2],
                dst: [1, 1],
                kind: Kind::Anchored,
            },
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
            ReduceLevel {
                src: [639, 479],
                dst: [319, 239],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [319, 239],
                dst: [159, 119],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [159, 119],
                dst: [79, 59],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [79, 59],
                dst: [39, 29],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [39, 29],
                dst: [19, 14],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [19, 14],
                dst: [9, 7],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [9, 7],
                dst: [4, 3],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [4, 3],
                dst: [2, 1],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [2, 1],
                dst: [1, 1],
                kind: Kind::Variable,
            },
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
            ReduceLevel {
                src: [17, 9],
                dst: [8, 4],
                kind: Kind::Variable,
            },
            ReduceLevel {
                src: [8, 4],
                dst: [4, 2],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [4, 2],
                dst: [2, 1],
                kind: Kind::Anchored,
            },
            ReduceLevel {
                src: [2, 1],
                dst: [1, 1],
                kind: Kind::Variable,
            },
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

