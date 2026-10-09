//! T18 A3 并行切片对拍的共享辅助,自 `cloth_parallel_compute_parity.rs` 原样拆出:
//! 纯 Rust SHA-256、fixture 读取、确定性贪心着色、固定归约树与 f32 指纹原语。
//! 除可见性(`pub`)与 fixture 相对路径(随文件位置改为 `../fixtures/`)外逐字未改。

use std::collections::HashSet;

use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/cloth-parallel-compute-v1.json");

// ─── 纯 Rust SHA-256(FIPS 180-4,测试门禁自包含,不新增依赖) ──────────────────

pub fn sha256_hex(message: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (message.len() as u64) * 8;
    let mut padded = message.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());
    for block in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

// ─── fixture 读取辅助 ─────────────────────────────────────────────────────────

pub fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("cloth-parallel fixture parses")
}

pub fn num(value: &Value) -> f64 {
    value.as_f64().expect("fixture number must be f64")
}

pub fn int32(value: &Value) -> i32 {
    let truncated = num(value).trunc();
    (truncated as i64).rem_euclid(1 << 32) as u32 as i32
}

pub fn u32_list(value: &Value) -> Vec<u32> {
    value
        .as_array()
        .expect("fixture u32 list")
        .iter()
        .map(|entry| u32::try_from(int32(entry)).expect("u32 entry"))
        .collect()
}

// ─── 确定性贪心着色(与 TS clothConstraintColoring.ts 逐位同构) ────────────────

pub struct Coloring {
    pub colors: Vec<u16>,
    pub color_count: usize,
    pub order: Vec<u32>,
    pub ranges: Vec<(usize, usize)>,
}

pub fn color_constraints(a: &[u32], b: &[u32], particle_count: usize) -> Coloring {
    assert_eq!(a.len(), b.len(), "endpoint arrays must align");
    let mut used = vec![0u32; particle_count];
    let mut colors = vec![0u16; a.len()];
    let mut color_count = 0usize;
    for k in 0..a.len() {
        let (endpoint_a, endpoint_b) = (a[k] as usize, b[k] as usize);
        assert_ne!(endpoint_a, endpoint_b, "constraint {k} is degenerate");
        let forbidden = used[endpoint_a] | used[endpoint_b];
        let mut color = 0u32;
        while color < 32 && (forbidden & (1u32 << color)) != 0 {
            color += 1;
        }
        assert!(color < 32, "constraint {k} needs color >= 32 (fail-closed)");
        colors[k] = color as u16;
        color_count = color_count.max(color as usize + 1);
        used[endpoint_a] |= 1 << color;
        used[endpoint_b] |= 1 << color;
    }
    let mut bucket_size = vec![0usize; color_count];
    for color in &colors {
        bucket_size[*color as usize] += 1;
    }
    let mut bucket_start = vec![0usize; color_count];
    let mut cursor = 0usize;
    for c in 0..color_count {
        bucket_start[c] = cursor;
        cursor += bucket_size[c];
    }
    let mut order = vec![0u32; a.len()];
    let mut fill = bucket_start.clone();
    for (k, color) in colors.iter().enumerate() {
        let slot = fill[*color as usize];
        fill[*color as usize] += 1;
        order[slot] = k as u32;
    }
    let ranges = (0..color_count)
        .map(|c| (bucket_start[c], bucket_start[c] + bucket_size[c]))
        .collect();
    Coloring {
        colors,
        color_count,
        order,
        ranges,
    }
}

/// 独立正确性断言:同色约束两两不共享端点;桶序全盖每个约束恰一次。
pub fn assert_coloring_valid(coloring: &Coloring, a: &[u32], b: &[u32]) {
    let mut seen: HashSet<u32> = HashSet::new();
    let mut covered = 0usize;
    for (c, &(start, end)) in coloring.ranges.iter().enumerate() {
        seen.clear();
        for slot in start..end {
            let k = coloring.order[slot] as usize;
            for endpoint in [a[k], b[k]] {
                assert!(
                    seen.insert(endpoint),
                    "color {c} shares particle {endpoint} across constraints"
                );
            }
            covered += 1;
        }
    }
    assert_eq!(
        covered,
        a.len(),
        "bucket order must cover every constraint exactly once"
    );
}

pub fn assert_coloring_matches(coloring: &Coloring, expected: &Value) {
    assert_eq!(
        coloring.color_count,
        expected["colorCount"].as_u64().unwrap() as usize
    );
    assert_eq!(
        coloring.colors,
        u32_list(&expected["colors"])
            .iter()
            .map(|&c| c as u16)
            .collect::<Vec<_>>()
    );
    assert_eq!(coloring.order, u32_list(&expected["order"]));
    let ranges: Vec<(usize, usize)> = expected["colorRanges"]
        .as_array()
        .expect("ranges")
        .iter()
        .map(|pair| {
            (
                pair.as_array().unwrap()[0].as_u64().unwrap() as usize,
                pair.as_array().unwrap()[1].as_u64().unwrap() as usize,
            )
        })
        .collect();
    assert_eq!(coloring.ranges, ranges);
}

// ─── 固定归约树(三级,与 TS clothParallelSolver.ts 逐运算同构) ─────────────────

fn tree_sum2(a: f32, b: f32) -> f32 {
    a + b
}

/// lane 内 4 元 pairwise 树:(a+b)+(c+d)。
pub fn tree_sum4(a: f32, b: f32, c: f32, d: f32) -> f32 {
    tree_sum2(tree_sum2(a, b), tree_sum2(c, d))
}

/// workgroup 共享内存 pairwise 树(64 lane,零填充)。
pub fn workgroup_tree_sum(lane_values: &[f32]) -> f32 {
    let width = 64usize;
    let mut shared = vec![0f32; width];
    for (i, slot) in shared.iter_mut().enumerate() {
        if i < lane_values.len() {
            *slot = lane_values[i];
        }
    }
    while shared.len() > 1 {
        let half = shared.len() / 2;
        for i in 0..half {
            shared[i] = shared[i * 2] + shared[i * 2 + 1];
        }
        shared.truncate(half);
    }
    shared[0]
}

/// 宿主合并树(跨 workgroup 部分和,零填充到 2 的幂)。
pub fn host_merge_tree_sum(partials: &[f32]) -> f32 {
    let mut level = 1usize;
    while level < partials.len() {
        level *= 2;
    }
    let mut shared = vec![0f32; level];
    for (i, slot) in shared.iter_mut().enumerate() {
        if i < partials.len() {
            *slot = partials[i];
        }
    }
    while shared.len() > 1 {
        let half = shared.len() / 2;
        for i in 0..half {
            shared[i] = shared[i * 2] + shared[i * 2 + 1];
        }
        shared.truncate(half);
    }
    shared[0]
}

/// FNV-1a 双车道 f32 指纹([px,py,pz,vx,vy,vz] 块序,小端字节)。
pub fn fingerprint_float32(values: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let mut forward: u32 = 0x811c_9dc5;
    let mut backward: u32 = 0x811c_9dc5;
    for (index, byte) in bytes.iter().enumerate() {
        forward = (forward ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
        backward = (backward ^ u32::from(bytes[bytes.len() - 1 - index])).wrapping_mul(0x0100_0193);
    }
    format!("{forward:08x}{backward:08x}")
}
