//! 记录画像二次扫描:以 placement 字为锚,把 2026(与 2024 对照)的
//! 记录头逐相对偏移做字段画像,产出字节级字段映射的直接证据。
//!
//! 方法:pass-1 全量特征扫描得到 placementInstance → 最近前驱 id 的
//! 距离主峰 anchor;pass-2 对每个 placement-instance 命中 p 取
//! R = p − anchor,u64@R join ElemTable 才计入,并对 R..R+PROF_LEN
//! 聚合 `RecordProfile`。锚点选择与候选资格都由字节决定,不预设布局。

use crate::common::*;
use crate::{dump_site, Scan};
use rvt::{compression, RevitFile};
use std::path::Path;

/// 对全部分区流做画像二次扫描(重新 inflate;边界记录如实计入 skipped)。
pub fn profile_partitions(
    scan: &mut Scan,
    rf: &mut RevitFile,
    paths: &[String],
    anchor: u64,
    outdir: &Path,
) -> RecordProfile {
    let mut profile = RecordProfile::new(anchor);
    if anchor == 0 || scan.ids.degraded {
        return profile;
    }
    for pidx in paths {
        let Ok(stored) = rf.read_stream(pidx) else { continue };
        let chunks = compression::inflate_all_chunks_for_stream(pidx, &stored);
        let mut window: Vec<u8> = Vec::new();
        let mut base: u64 = 0;
        for chunk in &chunks {
            window.extend_from_slice(chunk);
            if window.len() < WINDOW_BYTES {
                continue;
            }
            let limit = base + window.len() as u64 - CARRY_BYTES as u64;
            profile_window(scan, &window, base, limit, anchor, &mut profile, outdir, pidx);
            let keep = CARRY_BYTES.min(window.len());
            window = window.split_off(window.len() - keep);
            base = limit;
        }
        profile_window(
            scan,
            &window,
            base,
            base + window.len() as u64,
            anchor,
            &mut profile,
            outdir,
            pidx,
        );
        if profile.candidates >= PROFILE_MAX_CANDIDATES {
            break;
        }
    }
    profile
}

/// 测试入口:直接对一段缓冲跑画像窗口(base=0,limit=len)。
#[cfg(test)]
pub fn profile_window_for_test(
    scan: &mut Scan,
    buf: &[u8],
    anchor: usize,
    profile: &mut RecordProfile,
    outdir: &Path,
    stream: &str,
) {
    profile_window(scan, buf, 0, buf.len() as u64, anchor as u64, profile, outdir, stream);
}

/// 单窗口画像:placement-instance 命中 → 记录候选 → 逐偏移聚合。
fn profile_window(
    scan: &mut Scan,
    buf: &[u8],
    base: u64,
    limit: u64,
    anchor: u64,
    profile: &mut RecordProfile,
    outdir: &Path,
    stream: &str,
) {
    if scan.ids.degraded {
        return;
    }
    let n = buf.len();
    if n < 8 || (anchor as usize) >= n {
        return;
    }
    let a = anchor as usize;
    for i in 0..=(n - 8) {
        let abs = base + i as u64;
        if abs >= limit || profile.candidates >= PROFILE_MAX_CANDIDATES {
            break;
        }
        let w = u64::from_le_bytes(buf[i..i + 8].try_into().unwrap());
        if (w & 0xffff_ffff) != 0xffff_ef7f {
            continue;
        }
        let Some(r) = i.checked_sub(a) else { continue };
        if r + PROF_LEN > n {
            profile.boundary_skipped += 1;
            continue;
        }
        let head = u64::from_le_bytes(buf[r..r + 8].try_into().unwrap());
        if head == 0 || head > u64::from(u32::MAX) || !scan.ids.contains(head as u32) {
            continue;
        }
        profile.candidates += 1;
        profile.observe(&scan.ids, buf, r);
        dump_site(outdir, scan, stream, "recordCandidate", abs - anchor, r, buf);
    }
}
