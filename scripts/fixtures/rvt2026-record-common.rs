//! rvt2026-record-reverse 共享类型与统计原语。
//!
//! 被 `rvt2026-record-reverse.rs`(主探针)与
//! `rvt2026-record-profile.rs`(记录画像二次扫描)共用。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub const WINDOW_BYTES: usize = 32 * 1024 * 1024;
pub const CARRY_BYTES: usize = 64 * 1024;
pub const INFLATE_BUDGET: u64 = 1_610_612_736;
pub const FF_RUN_MIN: usize = 24;
pub const FF_RUN_CAP: usize = 4096;
pub const RING_LEN: usize = 64;
pub const MAX_DELTA: u64 = 0x200;
pub const MAX_STORED_OFFSETS: usize = 512;
pub const DUMP_BEFORE: usize = 0x40;
pub const DUMP_AFTER: usize = 0x140;
pub const FILE_BUDGET: u64 = 256 * 1024 * 1024;
/// 记录画像窗口长度:88B 头 + bbox + 引用表前段。
pub const PROF_LEN: usize = 0xD0;
/// 画像候选上限(防病态输入)。
pub const PROFILE_MAX_CANDIDATES: u64 = 300_000;

/// 已证明 2024 形态的关键偏移(对照组期望值,也是目标组的对照基线)。
pub const R2024_CAT_AT: u64 = 0x12;
pub const R2024_MARKER_AT: u64 = 0x50;
pub const R2024_M59F_AT: u64 = 0x0c;
pub const R2024_PLACE_AT: u64 = 0x42;
/// 0xff 哨兵带锚点候选:类别带 ≈ -2,00x,xxx 的符号扩展使最大 0xff run
/// 实际起于 +0x14 或 +0x15(取决于类别值第 2 字节),不止文档记载的
/// +0x1a(那是"哨兵 padding 字段"的起点)。逐锚点验证,不预设。
pub const FF_ANCHORS: [u64; 2] = [0x14, 0x15];

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 声明 ElementId 位集(O(1) join;id 域过大时退化为空集并如实标注)。
pub struct IdSet {
    pub words: Vec<u64>,
    pub max: u32,
    pub degraded: bool,
}

impl IdSet {
    pub fn build(ids: &BTreeSet<u32>) -> IdSet {
        let max = ids.iter().copied().max().unwrap_or(0);
        if max > 100_000_000 {
            return IdSet { words: Vec::new(), max, degraded: true };
        }
        let mut words = vec![0u64; (max as usize) / 64 + 1];
        for id in ids {
            words[(*id as usize) / 64] |= 1u64 << (*id % 64);
        }
        IdSet { words, max, degraded: false }
    }
    pub fn contains(&self, id: u32) -> bool {
        if self.degraded || id > self.max {
            return false;
        }
        self.words[(id as usize) / 64] & (1u64 << (id % 64)) != 0
    }
    pub fn set(&mut self, id: u32) {
        if self.degraded || id > self.max {
            return;
        }
        self.words[(id as usize) / 64] |= 1u64 << (id % 64);
    }
    pub fn count_ones(&self) -> u64 {
        self.words.iter().map(|w| u64::from(w.count_ones())).sum()
    }
}

/// 一类特征的命中统计:总数、前若干绝对偏移样本、8 字节对齐直方图。
#[derive(Default)]
pub struct Tally {
    pub total: u64,
    pub first: Vec<u64>,
    pub align: [u64; 8],
}

impl Tally {
    pub fn hit(&mut self, abs: u64) {
        self.total += 1;
        if self.first.len() < MAX_STORED_OFFSETS {
            self.first.push(abs);
        }
        self.align[(abs % 8) as usize] += 1;
    }
    pub fn value(&self, key: &str) -> Value {
        json!({
            key: {
                "total": self.total,
                "firstOffsets": self.first.iter().take(16).collect::<Vec<_>>(),
                "alignMod8": self.align,
            }
        })
    }
}

/// 最近前驱查找环:每类特征保留最近 RING_LEN 个绝对偏移。
#[derive(Default)]
pub struct Ring {
    pub offs: VecDeque<u64>,
}

impl Ring {
    pub fn push(&mut self, abs: u64) {
        if self.offs.len() == RING_LEN {
            self.offs.pop_front();
        }
        self.offs.push_back(abs);
    }
    /// pos 之前(不含 pos)、距离 ∈ [1, max_back] 的最近命中。
    pub fn nearest_within(&self, pos: u64, max_back: u64) -> Option<u64> {
        self.offs
            .iter()
            .rev()
            .map(|off| pos.checked_sub(*off).filter(|d| (1..=max_back).contains(d)))
            .flatten()
            .next()
    }
}

/// 字段间距直方图(距离 → 计数;超界/无前驱记为 miss)。
#[derive(Default)]
pub struct Deltas {
    pub map: BTreeMap<u32, u64>,
    pub misses: u64,
    pub pairs: u64,
}

impl Deltas {
    pub fn observe(&mut self, dist: Option<u64>) {
        if let Some(d) = dist.filter(|d| *d <= MAX_DELTA) {
            *self.map.entry(d as u32).or_default() += 1;
            self.pairs += 1;
        } else {
            self.misses += 1;
        }
    }
    pub fn value(&self) -> Value {
        let mut top: Vec<(u32, u64)> = self.map.iter().map(|(k, v)| (*k, *v)).collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        json!({
            "pairs": self.pairs,
            "misses": self.misses,
            "distinctDistances": self.map.len(),
            "top": top.into_iter().take(12).collect::<Vec<_>>(),
        })
    }
    pub fn peak(&self) -> Option<(u64, u64)> {
        self.map
            .iter()
            .max_by_key(|(_, v)| **v)
            .map(|(k, v)| (u64::from(*k), *v))
    }
}

/// id 命中处的 2024 形态字段瀑布(独立计数 + 联合计数)。
#[derive(Default)]
pub struct IdChecks {
    pub total: u64,
    pub u16_at_10_zero: u64,
    pub cat_band_at_12: u64,
    pub u32_at_0c_59f: u64,
    pub marker_at_50: u64,
    pub place_known_at_42: u64,
    pub all_five: u64,
}

impl IdChecks {
    pub fn value(&self) -> Value {
        json!({
            "idHitsTotal": self.total,
            "u16At0x10Zero": self.u16_at_10_zero,
            "catBandAt0x12": self.cat_band_at_12,
            "u32At0x0cEquals59f": self.u32_at_0c_59f,
            "bboxMarkerAt0x50": self.marker_at_50,
            "placementKnownAt0x42": self.place_known_at_42,
            "allFive": self.all_five,
        })
    }
}

/// 一个锚点候选(run_start − A)上的 2024 形态字段检查。
#[derive(Default)]
pub struct FfAnchor {
    pub id_join: u64,
    pub u16_zero: u64,
    pub cat_band: u64,
    pub marker: u64,
    pub place_known: u64,
    pub all_five: u64,
    pub decoded: u64,
    pub run_from_id: Deltas,
}

/// 0xff 哨兵带锚点统计:2024 形态在 +0x12 类别字段之后有跨字段的 0xff 带
/// (≥24B),记录候选起点 = run_start − A(A ∈ FF_ANCHORS),不依赖类别常量。
#[derive(Default)]
pub struct FfStats {
    pub runs: u64,
    pub giant: u64,
    pub max_run: usize,
    pub first: Vec<(u64, u64)>,
    pub anchors: BTreeMap<u64, FfAnchor>,
}

impl FfStats {
    pub fn value(&self) -> Value {
        let anchors: Vec<Value> = self
            .anchors
            .iter()
            .map(|(a, e)| {
                json!({
                    "anchor": a,
                    "idJoinsElemTable": e.id_join,
                    "u16At0x10Zero": e.u16_zero,
                    "catBandAt0x12": e.cat_band,
                    "bboxMarkerAt0x50": e.marker,
                    "placementKnownAt0x42": e.place_known,
                    "allFive": e.all_five,
                    "decode2024Shape": e.decoded,
                    "runStartMinusNearestPrecedingId": e.run_from_id.value(),
                })
            })
            .collect();
        json!({
            "runsAtLeast24B": self.runs,
            "giantRunsCapped": self.giant,
            "maxRunBytes": self.max_run,
            "firstRunsStartLen": self.first.iter().take(12).collect::<Vec<_>>(),
            "anchors": anchors,
        })
    }
}

/// 单个相对偏移的字段画像计数。
#[derive(Default)]
pub struct OffsetTallies {
    pub count: u64,
    pub u64_zero: u64,
    pub byte_ff: u64,
    pub f64_finite: u64,
    pub declared_id: u64,
    pub cat_band: u64,
    pub place_inst: u64,
    pub place_sym: u64,
    pub u32_ffffffff: u64,
    /// 精确 u64 常量(定期剪掉 count==1 的数据值,保住重复常量)。
    pub consts: BTreeMap<u64, u64>,
}

impl OffsetTallies {
    pub fn value(&self, offset: usize) -> Value {
        let mut consts: Vec<(u64, u64)> =
            self.consts.iter().map(|(k, v)| (*k, *v)).collect();
        consts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let consts: Vec<Value> = consts
            .into_iter()
            .take(4)
            .map(|(k, v)| json!({ "u64": format!("{k:#x}"), "count": v }))
            .collect();
        json!({
            "offset": format!("{offset:#04x}"),
            "samples": self.count,
            "u64Zero": self.u64_zero,
            "byteFF": self.byte_ff,
            "f64Finite": self.f64_finite,
            "declaredId": self.declared_id,
            "catBand": self.cat_band,
            "placementInstance": self.place_inst,
            "placementSymbol": self.place_sym,
            "u32FFFFFFFF": self.u32_ffffffff,
            "topConsts": consts,
        })
    }
}

/// 以 placement 字为锚的记录画像:R = placeAbs − anchor,
/// 对 R..R+PROF_LEN 逐相对偏移聚合字段特征 → 2026 字段映射的直接证据。
pub struct RecordProfile {
    pub anchor: u64,
    pub candidates: u64,
    pub boundary_skipped: u64,
    pub offsets: Vec<OffsetTallies>,
}

impl RecordProfile {
    pub fn new(anchor: u64) -> RecordProfile {
        RecordProfile {
            anchor,
            candidates: 0,
            boundary_skipped: 0,
            offsets: (0..PROF_LEN).map(|_| OffsetTallies::default()).collect(),
        }
    }

    pub fn observe(&mut self, ids: &IdSet, buf: &[u8], r: usize) {
        for (o, slot) in self.offsets.iter_mut().enumerate() {
            let at = r + o;
            if at + 8 > buf.len() {
                break;
            }
            let w = u64::from_le_bytes(buf[at..at + 8].try_into().unwrap());
            let lo = (w & 0xffff_ffff) as u32;
            slot.count += 1;
            if w == 0 {
                slot.u64_zero += 1;
            }
            if buf[at] == 0xff {
                slot.byte_ff += 1;
            }
            let v = f64::from_bits(w);
            if v.is_finite() && v.abs() <= 1.0e7 {
                slot.f64_finite += 1;
            }
            if w > 0 && w <= u64::from(u32::MAX) && ids.contains(w as u32) {
                slot.declared_id += 1;
            }
            let c = w as i64;
            if (-2_100_000..=-1_990_000).contains(&c) {
                slot.cat_band += 1;
            }
            if lo == 0xffff_ef7f {
                slot.place_inst += 1;
            }
            if lo == 0xffff_8000 {
                slot.place_sym += 1;
            }
            if lo == u32::MAX {
                slot.u32_ffffffff += 1;
            }
            if slot.consts.len() > 8192 {
                slot.consts.retain(|_, n| *n > 1);
            }
            *slot.consts.entry(w).or_default() += 1;
        }
    }

    pub fn value(&self) -> Value {
        json!({
            "anchorBytesBeforePlacement": self.anchor,
            "candidates": self.candidates,
            "boundarySkipped": self.boundary_skipped,
            "profileLength": PROF_LEN,
            "offsets": self
                .offsets
                .iter()
                .enumerate()
                .filter(|(_, s)| s.count > 0)
                .map(|(o, s)| s.value(o))
                .collect::<Vec<_>>(),
        })
    }
}

/// 十六进制转储:每行 16B,8 字节对齐行尾补 u64/i64/f64 重解释。
pub fn render_hexdump(buf: &[u8], center: u64) -> String {
    let mut out = String::new();
    out.push_str(&format!("center offset: {center} (0x{center:x})\n"));
    let mut line_start = 0usize;
    while line_start + 16 <= buf.len() {
        let row = &buf[line_start..line_start + 16];
        let hex: Vec<String> = row.iter().map(|b| format!("{b:02x}")).collect();
        let ascii: String = row
            .iter()
            .map(|b| if (0x20..0x7f).contains(b) { *b as char } else { '.' })
            .collect();
        let mut note = String::new();
        if line_start % 8 == 0 {
            let s0 = &buf[line_start..line_start + 8];
            let w0 = u64::from_le_bytes(s0.try_into().unwrap());
            note.push_str(&format!(
                " | u64 {w0:016x} i64 {} f64 {}",
                w0 as i64,
                f64::from_bits(w0)
            ));
        }
        out.push_str(&format!(
            "{:012x}  {}  |{}|{}\n",
            line_start,
            hex.join(" "),
            ascii,
            note
        ));
        line_start += 16;
    }
    out
}

/// 合并多个单键 JSON 对象(键冲突时后者覆盖;调用方保证各键唯一)。
pub fn merge_json(parts: Vec<Value>) -> Value {
    let mut out = serde_json::Map::new();
    for part in parts {
        if let Value::Object(map) = part {
            for (k, v) in map {
                out.insert(k, v);
            }
        }
    }
    Value::Object(out)
}
