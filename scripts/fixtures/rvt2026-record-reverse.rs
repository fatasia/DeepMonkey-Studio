//! RVT 2026 分区 element-record 形态字节级逆向探针(只读观察证据)。
//!
//! 背景:2024 分区记录形态已在 rvt-rs `partition_element_records` 逐字节证明
//! (88B 头:u64 id@0x00 / u32 flags@0x08 / u32 0x059f@0x0c / u16 0@0x10 /
//! i64 BuiltInCategory@0x12 / 0xff 哨兵带 0x1a..0x42 / u64 container@0x32 /
//! u32 placement@0x42 / bbox marker@0x50 / 6×f64 bbox@0x58 / 计数引用表@0x88),
//! 而 2026 上同一 `decode_at` 解码为 0。本探针做三层字节级观察:
//! 1. 特征搜索:u64 ID 候选(ElemTable join)、i64 类别带候选、f64 bbox 候选、
//!    0xff 哨兵带锚点、marker/placement/0x59f 字定位,输出偏移直方图与字段间距;
//! 2. 记录画像(`rvt2026-record-profile.rs`):以 placement 字为锚对记录头
//!    逐相对偏移聚合字段特征,产出字节级字段映射的直接证据;
//! 3. 方法学对照:同一逻辑跑 2024 真实文件,画像必须复现已证明布局。
//!
//! 窗口化:32MB 窗口、64KB 前叠(carry)。每窗口只报告起点落在
//! [base, limit) 的记录级特征(limit = base + len − CARRY),起点落在尾部
//! carry 区的记录由下一窗口完整报告,不重不漏;记录长度 ≤ CARRY 由
//! 2024 已证形态保证(88B 头 + 两张引用表 ≤ 数 KB)。
//!
//! 用法: rvt2026-record-reverse <outdir> <input.rvt>...
//!
//! 诚实条款:全部输出为观察统计,不构成任何生产支持;凡推导出的 2026
//! 字段映射一律标注 "2026 观察推导,需测试钉死";特征零命中就如实报告
//! "需要全新解析器(或存在更深层重写)"。

#[path = "rvt2026-record-common.rs"]
mod common;

#[path = "rvt2026-record-profile.rs"]
mod profile;

use common::*;
use rvt::partition_element_records as records;
use rvt::{compression, elem_table, object_graph, RevitFile};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

type Check<T> = Result<T, Box<dyn std::error::Error>>;

/// 单文件扫描累计状态(pass-1 特征搜索)。
pub struct Scan {
    pub declared: BTreeSet<u32>,
    pub ids: IdSet,
    pub decoded_ids: IdSet,
    pub declared_len: usize,
    pub id: Tally,
    pub cat: Tally,
    pub m59f: Tally,
    pub marker: Tally,
    pub place_inst: Tally,
    pub place_sym: Tally,
    pub bbox6: Tally,
    pub cat_values: BTreeMap<i64, u64>,
    pub near_59f: BTreeMap<u32, u64>,
    pub ring_id: Ring,
    pub ring_cat: Ring,
    pub ring_marker: Ring,
    pub ring_m59f: Ring,
    pub d_cat_from_id: Deltas,
    pub d_marker_from_cat: Deltas,
    pub d_marker_from_id: Deltas,
    pub d_m59f_from_id: Deltas,
    pub d_bbox6_from_cat: Deltas,
    pub d_place_from_id: Deltas,
    pub id_checks: IdChecks,
    pub ff: FfStats,
    pub decoded: u64,
    pub dump_sites: BTreeMap<&'static str, Option<(String, u64)>>,
}

impl Scan {
    pub fn new(declared: BTreeSet<u32>) -> Scan {
        let ids = IdSet::build(&declared);
        let decoded_ids = IdSet::build(&declared);
        let mut dump_sites: BTreeMap<&'static str, Option<(String, u64)>> = BTreeMap::new();
        for key in [
            "partitionHead", "ffRun", "categoryHit", "bboxMarker", "idAnchor", "m59f",
            "recordCandidate",
        ] {
            dump_sites.insert(key, None);
        }
        let declared_len = declared.len();
        Scan {
            declared,
            ids,
            decoded_ids,
            declared_len,
            id: Tally::default(),
            cat: Tally::default(),
            m59f: Tally::default(),
            marker: Tally::default(),
            place_inst: Tally::default(),
            place_sym: Tally::default(),
            bbox6: Tally::default(),
            cat_values: BTreeMap::new(),
            near_59f: BTreeMap::new(),
            ring_id: Ring::default(),
            ring_cat: Ring::default(),
            ring_marker: Ring::default(),
            ring_m59f: Ring::default(),
            d_cat_from_id: Deltas::default(),
            d_marker_from_cat: Deltas::default(),
            d_marker_from_id: Deltas::default(),
            d_m59f_from_id: Deltas::default(),
            d_bbox6_from_cat: Deltas::default(),
            d_place_from_id: Deltas::default(),
            id_checks: IdChecks::default(),
            ff: FfStats::default(),
            decoded: 0,
            dump_sites,
        }
    }
}

/// 登记并落盘一个 hexdump 站点(每类站点只取第一次命中)。
pub fn dump_site(
    outdir: &Path,
    scan: &mut Scan,
    stream: &str,
    label: &'static str,
    abs: u64,
    i: usize,
    buf: &[u8],
) {
    if scan.dump_sites.get(label).map_or(true, |s| s.is_some()) {
        return;
    }
    let from = i.saturating_sub(DUMP_BEFORE);
    let to = (i + DUMP_AFTER).min(buf.len());
    if to <= from {
        return;
    }
    let text = render_hexdump(&buf[from..to], abs);
    let file = format!("hexdump-{label}-{abs}.txt");
    if std::fs::write(outdir.join(&file), &text).is_ok() {
        scan.dump_sites.insert(label, Some((stream.to_string(), abs)));
    }
}

fn main() -> Check<()> {
    let mut args = std::env::args().skip(1);
    let outdir =
        PathBuf::from(args.next().ok_or("usage: rvt2026-record-reverse <outdir> <input.rvt>...")?);
    let inputs: Vec<String> = args.collect();
    if inputs.is_empty() {
        return Err("no input files".into());
    }
    std::fs::create_dir_all(&outdir)?;
    let mut files = Vec::new();
    for input in &inputs {
        files.push(probe_file(Path::new(input), &outdir)?);
    }
    let report = json!({
        "schemaVersion": 1,
        "scope": "rvt-partition-record-reverse",
        "method": "byte-level feature search + offset-relation histograms + placement-anchored record profile; 2024 file = methodology control",
        "honesty": "observation only; proposed 2026 mappings are '观察推导,需测试钉死'; zero-hit features mean the 2024 shape does not transfer",
        "files": files,
    });
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(outdir.join("evidence.json"))?
        .write_all(&serde_json::to_vec_pretty(&report)?)?;
    println!(
        "{}",
        json!({
            "files": files
                .iter()
                .map(|f| (f["role"].clone(), f["revitVersion"].clone(), f["verdict"]["tier"].clone()))
                .collect::<Vec<_>>(),
        })
    );
    Ok(())
}

/// 单文件探针:ElemTable 声明集 → pass-1 特征搜索 → pass-2 记录画像 → 汇总。
fn probe_file(path: &Path, outdir: &Path) -> Check<Value> {
    let raw_file = {
        let mut f = std::fs::File::open(path)?;
        let size = f.metadata()?.len();
        if size > FILE_BUDGET {
            return Err("source exceeds research budget".into());
        }
        let mut bytes = Vec::with_capacity(size as usize);
        f.read_to_end(&mut bytes)?;
        bytes
    };
    let sha = hash(&raw_file);
    let mut rf = RevitFile::open_bytes(raw_file)?;
    let version = rf.basic_file_info()?.version;
    let role = match version {
        2024 => "control-2024",
        2026 => "target-2026",
        _ => "other",
    };

    // --- ElemTable 声明集(逐行 40B framing 验证,与统计探针同一纪律)---
    let mut declared = BTreeSet::new();
    let mut framing_verified = true;
    let mut id_min = u32::MAX;
    let mut id_max = 0u32;
    match elem_table::parse_records(&mut rf) {
        Ok(table) if !table.is_empty() => {
            for row in &table {
                if row.raw.len() != 40
                    || u32::from_le_bytes(row.raw[16..20].try_into().unwrap()) != row.id_primary
                    || u32::from_le_bytes(row.raw[36..40].try_into().unwrap()) != row.id_secondary
                {
                    framing_verified = false;
                    break;
                }
                if row.id_primary == 0 || row.id_primary == u32::MAX {
                    continue;
                }
                declared.insert(row.id_primary);
                id_min = id_min.min(row.id_primary);
                id_max = id_max.max(row.id_primary);
            }
        }
        _ => framing_verified = false,
    }
    let elem_table_json = json!({
        "declaredElementIds": declared.len(),
        "framing40BVerifiedPerRow": framing_verified,
        "idRange": { "min": if id_min == u32::MAX { 0 } else { id_min }, "max": id_max },
    });

    let mut scan = Scan::new(declared);
    let mut partitions = Vec::new();
    let mut partial_inflate = false;
    let mut paths: Vec<String> = rf
        .stream_names()
        .into_iter()
        .filter(|s| s.starts_with("Partitions/"))
        .collect();
    paths.sort();

    for pidx in &paths {
        let stored = rf.read_stream(pidx)?;
        let prepared = compression::prepare_stream_for_inflate(pidx, &stored);
        let stored_len = prepared.len();
        let chunks = compression::inflate_all_chunks_for_stream(pidx, &stored);
        let inflated_total: u64 = chunks.iter().map(|c| c.len() as u64).sum();
        if inflated_total > INFLATE_BUDGET {
            partial_inflate = true;
            partitions.push(json!({
                "path": pidx, "storedBytes": stored_len,
                "inflatedBytes": inflated_total,
                "chunks": chunks.len(), "status": "skipped-inflate-budget-exceeded",
            }));
            continue;
        }
        if let Some(head) = chunks.first() {
            let take: Vec<u8> = head.iter().take(0x100).copied().collect();
            dump_site(outdir, &mut scan, pidx, "partitionHead", 0, 0, &take);
        }
        // 字符串记录(逐 chunk 下界计数;跨 chunk 边界记录不补窗口,如实标注)。
        let mut string_count = 0u64;
        let mut string_tags: BTreeMap<u32, u64> = BTreeMap::new();
        let mut string_samples: Vec<String> = Vec::new();
        for chunk in &chunks {
            for sr in object_graph::extract_string_records(chunk) {
                string_count += 1;
                *string_tags.entry(sr.tag).or_default() += 1;
                if string_samples.len() < 5 {
                    string_samples.push(sr.value.chars().take(48).collect());
                }
            }
        }
        let mut window: Vec<u8> = Vec::new();
        let mut base: u64 = 0;
        for chunk in &chunks {
            window.extend_from_slice(chunk);
            if window.len() < WINDOW_BYTES {
                continue;
            }
            let limit = base + window.len() as u64 - CARRY_BYTES as u64;
            process_window(&mut scan, pidx, &window, base, limit, outdir);
            let keep = CARRY_BYTES.min(window.len());
            window = window.split_off(window.len() - keep);
            base = limit;
        }
        process_window(&mut scan, pidx, &window, base, base + window.len() as u64, outdir);
        let mut tags: Vec<(u32, u64)> = string_tags.into_iter().collect();
        tags.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        partitions.push(json!({
            "path": pidx, "storedBytes": stored_len,
            "inflatedBytes": inflated_total, "chunks": chunks.len(),
            "stringRecordsPerChunkLowerBound": {
                "count": string_count,
                "topTags": tags.into_iter().take(12).collect::<Vec<_>>(),
                "samples": string_samples,
            },
            "status": "scanned",
        }));
    }

    // --- pass-2:placement 锚定记录画像(锚点由 pass-1 直方图主峰决定)---
    let anchor = scan.d_place_from_id.peak().filter(|(_, c)| *c >= 1000).map(|(d, _)| d);
    let record_profile = match anchor {
        Some(a) => Some(profile::profile_partitions(&mut scan, &mut rf, &paths, a, outdir)),
        None => None,
    };

    Ok(compose_report(
        path,
        &sha,
        role,
        version,
        elem_table_json,
        partitions,
        partial_inflate,
        &scan,
        record_profile.as_ref(),
    ))
}

/// 对一个窗口执行 pass-1 全部特征统计。`limit` 是本窗口负责报告的绝对
/// 偏移上界(尾部 CARRY 前叠区留给下一窗口,保证记录级特征不重不漏)。
fn process_window(
    scan: &mut Scan,
    stream: &str,
    buf: &[u8],
    base: u64,
    limit: u64,
    outdir: &Path,
) {
    if scan.ids.degraded {
        return; // id 域退化时本探针不做任何主张。
    }
    let n = buf.len();
    if n < 8 {
        return;
    }
    // --- 主特征循环:逐字节偏移读 u64 ---
    for i in 0..=(n - 8) {
        let abs = base + i as u64;
        if abs >= limit {
            break;
        }
        let w = u64::from_le_bytes(buf[i..i + 8].try_into().unwrap());
        let cat = w as i64;
        let lo = (w & 0xffff_ffff) as u32;

        // u64 ID 候选(ElemTable join)
        if w > 0 && w <= u64::from(u32::MAX) && scan.ids.contains(w as u32) {
            let id = w as u32;
            scan.id.hit(abs);
            let has = |off: usize| i + off <= n - 1;
            let u16z = has(0x11) && u16::from_le_bytes([buf[i + 0x10], buf[i + 0x11]]) == 0;
            let catb = has(0x19) && {
                let c = u64::from_le_bytes(buf[i + 0x12..i + 0x1a].try_into().unwrap()) as i64;
                (records::BUILTIN_CATEGORY_MIN..=records::BUILTIN_CATEGORY_MAX).contains(&c)
            };
            let m59 = has(0x0f)
                && u32::from_le_bytes(buf[i + 0x0c..i + 0x10].try_into().unwrap()) == 0x59f;
            let mark = has(0x57) && buf[i + 0x50..i + 0x58] == records::BBOX_MARKER;
            let plk = has(0x45) && {
                let p = u32::from_le_bytes(buf[i + 0x42..i + 0x46].try_into().unwrap());
                p == records::PLACEMENT_KIND_INSTANCE || p == records::PLACEMENT_KIND_SYMBOL
            };
            scan.id_checks.total += 1;
            scan.id_checks.u16_at_10_zero += u64::from(u16z);
            scan.id_checks.cat_band_at_12 += u64::from(catb);
            scan.id_checks.u32_at_0c_59f += u64::from(m59);
            scan.id_checks.marker_at_50 += u64::from(mark);
            scan.id_checks.place_known_at_42 += u64::from(plk);
            if u16z && catb && m59 && mark && plk {
                scan.id_checks.all_five += 1;
            }
            // decode_at 完整验证(预过滤与 decode_at 拒绝顺序一致,不改变结果)
            if u16z && catb && records::decode_at(stream, buf, i, &scan.declared).is_some() {
                scan.decoded += 1;
                scan.decoded_ids.set(id);
            }
            if u16z && catb && m59 {
                dump_site(outdir, scan, stream, "idAnchor", abs, i, buf);
            }
            scan.ring_id.push(abs);
        }

        // i64 类别带候选
        if (records::BUILTIN_CATEGORY_MIN..=records::BUILTIN_CATEGORY_MAX).contains(&cat) {
            scan.cat.hit(abs);
            *scan.cat_values.entry(cat).or_default() += 1;
            scan.d_cat_from_id.observe(scan.ring_id.nearest_within(abs, MAX_DELTA));
            dump_site(outdir, scan, stream, "categoryHit", abs, i, buf);
            scan.ring_cat.push(abs);
        }
        // u32 0x59f 及邻近常量(捕捉 2026 常量微调)
        if lo == 0x59f {
            scan.m59f.hit(abs);
            scan.d_m59f_from_id.observe(scan.ring_id.nearest_within(abs, MAX_DELTA));
            dump_site(outdir, scan, stream, "m59f", abs, i, buf);
            scan.ring_m59f.push(abs);
        } else if (0x590..=0x5b0).contains(&lo) && (w >> 32) == 0 {
            *scan.near_59f.entry(lo).or_default() += 1;
        }
        // placement 字
        if lo == records::PLACEMENT_KIND_INSTANCE {
            scan.place_inst.hit(abs);
            scan.d_place_from_id.observe(scan.ring_id.nearest_within(abs, MAX_DELTA));
        } else if lo == records::PLACEMENT_KIND_SYMBOL {
            scan.place_sym.hit(abs);
        }
        // bbox marker
        if w == u64::from_le_bytes(records::BBOX_MARKER) {
            scan.marker.hit(abs);
            scan.d_marker_from_cat.observe(scan.ring_cat.nearest_within(abs, MAX_DELTA));
            scan.d_marker_from_id.observe(scan.ring_id.nearest_within(abs, MAX_DELTA));
            dump_site(outdir, scan, stream, "bboxMarker", abs, i, buf);
            scan.ring_marker.push(abs);
        }
        // 6×f64 bbox 候选(有限、逐轴 min≤max、非全零、量级合理)
        if i + 0x30 <= n {
            let mut ok = true;
            let mut nonzero = false;
            let mut vals = [0f64; 6];
            for (axis, slot) in vals.iter_mut().enumerate() {
                let at = i + axis * 8;
                let v = f64::from_le_bytes(buf[at..at + 8].try_into().unwrap());
                if !v.is_finite() || v.abs() > 1.0e7 {
                    ok = false;
                    break;
                }
                *slot = v;
                if v.abs() > 1.0e-4 {
                    nonzero = true;
                }
            }
            if ok && nonzero {
                for axis in 0..3 {
                    if vals[axis + 3] < vals[axis] {
                        ok = false;
                        break;
                    }
                }
            }
            if ok && nonzero
                && (vals[3] - vals[0] > 0.0 || vals[4] - vals[1] > 0.0 || vals[5] - vals[2] > 0.0)
            {
                scan.bbox6.hit(abs);
                scan.d_bbox6_from_cat.observe(scan.ring_cat.nearest_within(abs, MAX_DELTA));
            }
        }
    }
    // --- 0xff 哨兵带锚点:run ≥ 24B → 记录候选 = run_start − A ---
    let mut run_start: Option<usize> = None;
    for i in 0..=n {
        let is_ff = i < n && buf[i] == 0xff;
        if is_ff && run_start.is_none() {
            run_start = Some(i);
        }
        if !is_ff {
            if let Some(start) = run_start {
                run_start = None;
                let len = i - start;
                let run_abs = base + start as u64;
                if run_abs >= limit {
                    continue; // 起点在 carry 区:下一窗口完整报告
                }
                if len >= FF_RUN_CAP {
                    scan.ff.giant += 1;
                    continue;
                }
                if len < FF_RUN_MIN {
                    continue;
                }
                scan.ff.runs += 1;
                scan.ff.max_run = scan.ff.max_run.max(len);
                if scan.ff.first.len() < 12 {
                    scan.ff.first.push((run_abs, len as u64));
                }
                for a in FF_ANCHORS {
                    if let Some(r) = start.checked_sub(a as usize) {
                        check_ff_anchor(scan, stream, buf, r, run_abs - a, run_abs, a, outdir);
                    }
                }
            }
        }
    }
}

/// 在 run_start−A 的记录候选上做 2024 形态字段检查 + 完整解码。
fn check_ff_anchor(
    scan: &mut Scan,
    stream: &str,
    buf: &[u8],
    r: usize,
    r_abs: u64,
    run_abs: u64,
    anchor: u64,
    outdir: &Path,
) {
    if r + 8 > buf.len() {
        return;
    }
    let w = u64::from_le_bytes(buf[r..r + 8].try_into().unwrap());
    let id_ok = w > 0 && w <= u64::from(u32::MAX) && scan.ids.contains(w as u32);
    let has = |off: usize| r + off <= buf.len() - 1;
    let u16z = has(0x11) && u16::from_le_bytes([buf[r + 0x10], buf[r + 0x11]]) == 0;
    let catb = has(0x19) && {
        let c = u64::from_le_bytes(buf[r + 0x12..r + 0x1a].try_into().unwrap()) as i64;
        (records::BUILTIN_CATEGORY_MIN..=records::BUILTIN_CATEGORY_MAX).contains(&c)
    };
    let mark = has(0x57) && buf[r + 0x50..r + 0x58] == records::BBOX_MARKER;
    let plk = has(0x45) && {
        let p = u32::from_le_bytes(buf[r + 0x42..r + 0x46].try_into().unwrap());
        p == records::PLACEMENT_KIND_INSTANCE || p == records::PLACEMENT_KIND_SYMBOL
    };
    let decoded_ok =
        id_ok && u16z && catb && records::decode_at(stream, buf, r, &scan.declared).is_some();
    let run_from_id = scan.ring_id.nearest_within(run_abs, MAX_DELTA);
    let entry = scan.ff.anchors.entry(anchor).or_default();
    entry.id_join += u64::from(id_ok);
    entry.u16_zero += u64::from(u16z);
    entry.cat_band += u64::from(catb);
    entry.marker += u64::from(mark);
    entry.place_known += u64::from(plk);
    if id_ok && u16z && catb && mark && plk {
        entry.all_five += 1;
    }
    entry.decoded += u64::from(decoded_ok);
    entry.run_from_id.observe(run_from_id);
    if id_ok {
        dump_site(outdir, scan, stream, "ffRun", r_abs, r, buf);
    }
}

/// 汇总单文件报告(特征统计 + 偏移关系 + 画像 + 三档裁决)。
fn compose_report(
    path: &Path,
    sha: &str,
    role: &str,
    version: u32,
    elem_table_json: Value,
    partitions: Vec<Value>,
    partial_inflate: bool,
    scan: &Scan,
    record_profile: Option<&RecordProfile>,
) -> Value {
    let mut cat_values: Vec<(i64, u64)> = scan.cat_values.iter().map(|(k, v)| (*k, *v)).collect();
    cat_values.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut near59f: Vec<(u32, u64)> = scan.near_59f.iter().map(|(k, v)| (*k, *v)).collect();
    near59f.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let declared_n = scan.declared_len as f64;
    let decoded_n = scan.decoded_ids.count_ones() as f64;

    let (tier, basis, proposed) = derive_verdict(scan);
    let mut dumps = Vec::new();
    for (label, site) in &scan.dump_sites {
        if let Some((stream, abs)) = site {
            dumps.push(json!({
                "label": label, "stream": stream, "offset": abs,
                "file": format!("hexdump-{label}-{abs}.txt"),
            }));
        }
    }
    let profile_json = match record_profile {
        Some(p) => p.value(),
        None => json!({ "status": "no-dominant-placement-anchor" }),
    };
    json!({
        "path": path.display().to_string(),
        "sha256": sha,
        "role": role,
        "revitVersion": version,
        "elemTable": elem_table_json,
        "coverage": { "partialInflateBudget": partial_inflate },
        "partitions": partitions,
        "features": merge_json(vec![
            scan.id.value("idJoinCandidates"),
            scan.cat.value("categoryBandCandidates"),
            scan.m59f.value("u32_0x59f"),
            scan.marker.value("bboxMarker8B"),
            scan.place_inst.value("placementInstanceWord"),
            scan.place_sym.value("placementSymbolWord"),
            scan.bbox6.value("bbox6F64Candidate"),
        ]),
        "categoryValueCountsTop32": cat_values.into_iter().take(32).collect::<Vec<_>>(),
        "u32Near59fCounts": near59f.into_iter().take(12).collect::<Vec<_>>(),
        "offsetRelations": {
            "categoryMinusNearestPrecedingId": scan.d_cat_from_id.value(),
            "bboxMarkerMinusNearestPrecedingCategory": scan.d_marker_from_cat.value(),
            "bboxMarkerMinusNearestPrecedingId": scan.d_marker_from_id.value(),
            "u32_59fMinusNearestPrecedingId": scan.d_m59f_from_id.value(),
            "bbox6MinusNearestPrecedingCategory": scan.d_bbox6_from_cat.value(),
            "placementInstanceMinusNearestPrecedingId": scan.d_place_from_id.value(),
        },
        "idNeighborhood": scan.id_checks.value(),
        "ffRunAnchors": scan.ff.value(),
        "decode2024Shape": {
            "decodedRecords": scan.decoded,
            "distinctIds": scan.decoded_ids.count_ones(),
            "joinRatioOfDeclared": if declared_n == 0.0 { 0.0 } else { decoded_n / declared_n },
        },
        "recordProfile": profile_json,
        "hexDumps": dumps,
        "verdict": { "tier": tier, "basis": basis, "proposedMapping": proposed },
    })
}

/// 由统计直方图推导三档裁决与候选字段映射(本文件字节统计,确定性)。
fn derive_verdict(scan: &Scan) -> (String, Vec<String>, Value) {
    let mut basis = Vec::new();
    let zero_features = scan.cat.total == 0
        && scan.marker.total == 0
        && scan.m59f.total == 0
        && scan.place_inst.total == 0
        && scan.place_sym.total == 0
        && scan.ff.runs == 0;
    if zero_features {
        basis.push("全部 2024 特征(类别带/0x59f/marker/placement/0xff 带)零命中".into());
        return ("C-not-derivable-from-2024-features".into(), basis, Value::Null);
    }
    // 主峰:类别命中到最近前驱 id 的距离 → 记录起点偏移候选。
    let peak_cat = scan.d_cat_from_id.peak();
    let peak_marker_id = scan.d_marker_from_id.peak();
    let peak_m59f_id = scan.d_m59f_from_id.peak();
    let best_anchor = scan.ff.anchors.iter().max_by_key(|(_, e)| e.id_join).map(|(a, e)| (*a, e));
    if let Some((a, e)) = best_anchor {
        let peak = e.run_from_id.peak();
        basis.push(format!(
            "ff 锚点 A={a:#x}: idJoin={}, decode2024Shape={}, runMinusPrecedingId 主峰 {peak:?}",
            e.id_join, e.decoded
        ));
    } else {
        basis.push("无 ff 锚点命中".into());
    }
    if let Some((d, count)) = peak_cat {
        basis.push(format!(
            "categoryMinusPrecedingId 主峰 d={d:#x}(count={count}/pairs={})",
            scan.d_cat_from_id.pairs
        ));
    }
    basis.push(format!(
        "m59fMinusPrecedingId 主峰 {peak_m59f_id:?};2024 期望 {R2024_M59F_AT:#x}"
    ));
    let peak_place_id = scan.d_place_from_id.peak();
    basis.push(format!(
        "placementMinusPrecedingId 主峰 {peak_place_id:?};2024 期望 {R2024_PLACE_AT:#x}"
    ));
    let dominant = peak_cat
        .filter(|&(_, c)| c * 2 >= scan.d_cat_from_id.pairs && scan.cat.total > 0)
        .map(|(d, _)| d);
    match dominant {
        Some(d) => {
            let proposed = json!({
                "status": "2026 观察推导,需测试钉死",
                "recordStartToCategory": d,
                "recordStartToBboxMarker": peak_marker_id.map(|(m, _)| m),
                "note": "偏移由直方图主峰推导;字段语义未证;与 2024 常量的差异逐项见 offsetRelations",
            });
            let same = d == R2024_CAT_AT && peak_marker_id.map(|(m, _)| m) == Some(R2024_MARKER_AT);
            let tier =
                if same { "A-same-skeleton-2024-offsets" } else { "A-same-skeleton-shifted-offsets" };
            (tier.into(), basis, proposed)
        }
        None => {
            basis.push("类别带命中存在但无主导 record-start 距离".into());
            ("C-not-derivable-from-2024-features".into(), basis, Value::Null)
        }
    }
}

#[cfg(test)]
#[path = "rvt2026-record-reverse-tests.rs"]
mod tests;
