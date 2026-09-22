use super::{compression, elem_table, Check};
use rvt::RevitFile;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn row_ids(d: &[u8], rs: usize) -> Option<(u32, u32)> {
    let a = d.get(rs + 16..rs + 20)?;
    let b = d.get(rs + 36..rs + 40)?;
    Some((
        u32::from_le_bytes(a.try_into().ok()?),
        u32::from_le_bytes(b.try_into().ok()?),
    ))
}

/// 库 detect_layout 对部分 2024 变体(+4 槽位是 u64 0x10 而非 FF 标记,
/// 如 Snowdon Towers)会回退 Implicit,把 id 读成 0/0xFFFFFFFF。此回退按
/// 已证明的 2024 40 字节形态做确定性再推导:
/// 1. u16 头的 record_count × 40 + start 必须**精确等于** inflate 总长;
/// 2. 逐行验证 +16 主 id == +36 副 id(库文档不变式)、id 非 0/非
///    0xFFFFFFFF、id 序列非降序,允许 ≤1% 行副 id 不同并如实报告;
/// 3. 无候选满足则保持 fail-closed。
/// 库 detect_layout 对部分 2024 变体(+4 槽位是 u64 0x10 而非 FF 标记,
/// 如 Snowdon Towers)会回退 Implicit,把 id 读成 0/0xFFFFFFFF。此回退按
/// 已证明的 2024 40 字节形态做确定性再推导:
/// 1. u16 头的 record_count × 40 + start 必须精确等于 inflate 总长;
/// 2. 主 id 取 +16、副 id 取 +36(库文档不变式);副≠主 ≤1%、非单调 ≤1%、
///    退化 id(0/0xFFFFFFFF)≤0.1% 才接受,计数全部如实报告;
/// 3. 无候选满足则保持 fail-closed。
/// 返回 (start, verifiedRows, totalRows, secondaryMismatchRows, nonMonotonicRows, degenerateRows)。
fn derive_2024_layout(
    d: &[u8],
    record_count: usize,
) -> Option<(usize, usize, usize, usize, usize, usize)> {
    if record_count == 0 || d.len() < record_count * 40 {
        return None;
    }
    for start in 0x10..=0x40 {
        if start + record_count * 40 != d.len() {
            continue;
        }
        let mut previous: u32 = 0;
        let mut verified = 0usize;
        let mut mismatches = 0usize;
        let mut non_monotonic = 0usize;
        let mut degenerate = 0usize;
        for k in 0..record_count {
            let Some((id_primary, id_secondary)) = row_ids(d, start + 40 * k) else {
                return None;
            };
            if id_primary == 0 || id_primary == u32::MAX {
                degenerate += 1;
                continue;
            }
            if id_primary != id_secondary {
                mismatches += 1;
            }
            if id_primary < previous {
                non_monotonic += 1;
            }
            previous = id_primary;
            verified += 1;
        }
        let accepted = mismatches * 100 <= record_count
            && non_monotonic * 100 <= record_count
            && degenerate * 1000 <= record_count;
        if accepted {
            return Some((start, verified, record_count, mismatches, non_monotonic, degenerate));
        }
    }
    None
}

pub(super) fn inspect_elem_table(
    rf: &mut RevitFile,
    version: u32,
    failures: &mut Vec<Value>,
) -> (BTreeSet<u32>, Value) {
    let mut declared: BTreeSet<u32> = BTreeSet::new();
    match elem_table::parse_records(rf) {
        Ok(table) if table.iter().any(|row| row.id_primary != 0 && row.id_primary != u32::MAX) => {
            let mut id_min = u32::MAX;
            let mut id_max = 0u32;
            let mut framing_verified = true;
            for row in &table {
                // framing 不变量对任何版本都做逐行字节验证(2026-09-19 升级:
                // 之前按版本号拒绝,但观察证明 2026 的 ElemTable framing 与
                // 已证明 2024 形态逐字节同构——验证的是字节,不是版本号)。
                if row.raw.len() != 40
                    || u32::from_le_bytes(row.raw[16..20].try_into().unwrap()) != row.id_primary
                    || u32::from_le_bytes(row.raw[36..40].try_into().unwrap()) != row.id_secondary
                {
                    framing_verified = false;
                    break;
                }
                declared.insert(row.id_primary);
                id_min = id_min.min(row.id_primary);
                id_max = id_max.max(row.id_primary);
            }
            if !framing_verified {
                failures.push(json!({
                    "stage": "elem-table",
                    "error": "row failed the proven 40-byte framing check; counts withheld"
                }));
                (BTreeSet::new(), json!({"status": "failed", "error": "40-byte framing check failed"}))
            } else {
                let framing = if version == 2024 {
                    json!({"stride": 40, "verifiedPerRow": true, "source": "library detect_layout"})
                } else {
                    // 非 2024 但逐行通过 40 字节不变量:如实标注证据来源为
                    // 本文件实际字节的逐行验证(非版本号假设)。下游
                    // partition-element-records 形态门不受影响,仍独立按
                    // supports_revit_version 把关。
                    json!({"stride": 40, "verifiedPerRow": true,
                           "source": "per-row byte invariants identical to proven 2024 framing (verified on this file)"})
                };
                let status = if declared.is_empty() { "empty-declared-index" } else { "measured" };
                let declared_count = declared.len();
                (declared, json!({
                    "status": status,
                    "declaredElementIds": declared_count,
                    "idRange": { "min": id_min, "max": id_max },
                    "framing": framing,
                }))
            }
        }
        library_outcome => {
            let rederived = (|| -> Option<Value> {
                let raw = rf.read_stream(rvt::streams::GLOBAL_ELEM_TABLE).ok()?;
                let d = compression::inflate_stream_at(rvt::streams::GLOBAL_ELEM_TABLE, &raw, 8)
                    .or_else(|_| compression::inflate_stream_at(rvt::streams::GLOBAL_ELEM_TABLE, &raw, 0))
                    .ok()?;
                let record_count = elem_table::parse_header(rf).ok()?.record_count as usize;
                let (start, verified, total, mismatches, non_monotonic, degenerate) =
                    derive_2024_layout(&d, record_count)?;
                let mut id_min = u32::MAX;
                let mut id_max = 0u32;
                for k in 0..total {
                    let rs = start + 40 * k;
                    let Some((id_primary, _)) = row_ids(&d, rs) else { continue };
                    if id_primary == 0 || id_primary == u32::MAX {
                        continue; // 退化行不进 declared 集。
                    }
                    declared.insert(id_primary);
                    id_min = id_min.min(id_primary);
                    id_max = id_max.max(id_primary);
                }
                let declared_count = declared.len();
                Some(json!({
                    "status": "measured",
                    "declaredElementIds": declared_count,
                    "idRange": { "min": id_min, "max": id_max },
                    "framing": {
                        "stride": 40, "start": start,
                        "verifiedPerRow": verified == total,
                        "secondaryEqualsPrimaryRows": verified - mismatches,
                        "secondaryMismatchRows": mismatches,
                        "nonMonotonicRows": non_monotonic,
                        "degenerateRows": degenerate,
                        "totalRows": total,
                        "source": "deterministic re-derivation (exact byte fit + id invariants)",
                        "note": "library detect_layout output was degenerate for this file"
                    },
                }))
            })();
            match rederived {
                Some(value) => (declared, value),
                None => {
                    // 布局观察(失败路径,不声明任何布局):对 inflate 后的
                    // GLOBAL_ELEM_TABLE 裸字节区做步长拟合观察——
                    // 1) 头部 record_count(若可读)与流长的隐含步长;
                    // 2) 候选步长 {40,44,48,56} 下,把每 k*stride 处的 u32 当作
                    //    候选 id,统计"非零、非 0xFFFFFFFF、首值后单调不减"的行占比。
                    // 已证明 2024 形态的预期:40 步长得分≈100%,其余≈低分——
                    // 观察器先用 2024 自校验,再观察 2026 哪个步长显形。
                    let observation = (|| -> Option<Value> {
                        let raw = rf.read_stream(rvt::streams::GLOBAL_ELEM_TABLE).ok()?;
                        let d = compression::inflate_stream_at(rvt::streams::GLOBAL_ELEM_TABLE, &raw, 8)
                            .or_else(|_| compression::inflate_stream_at(rvt::streams::GLOBAL_ELEM_TABLE, &raw, 0))
                            .ok()?;
                        let header = elem_table::parse_header(rf).ok();
                        let record_count = header.as_ref().map(|h| h.record_count as u64);
                        let implied_stride = match (d.len() as u64, record_count) {
                            (len, Some(count)) if count > 0 => Some(len / count),
                            _ => None,
                        };
                        let plausible = |word: u32| word != 0 && word != u32::MAX && word < 100_000_000;
                        let mut stride_scores: Vec<Value> = Vec::new();
                        for stride in [40u64, 44, 48, 56] {
                            if (d.len() as u64) < stride { continue; }
                            let rows = (d.len() as u64) / stride;
                            let mut plausible_rows: u64 = 0;
                            let mut monotonic_rows: u64 = 0;
                            let mut prev: Option<u32> = None;
                            for k in 0..rows {
                                let off = (k * stride) as usize;
                                let word = u32::from_le_bytes(d[off..off + 4].try_into().ok()?);
                                if plausible(word) {
                                    plausible_rows += 1;
                                    if prev.map_or(true, |p| word >= p) { monotonic_rows += 1; }
                                    prev = Some(word);
                                }
                            }
                            stride_scores.push(json!({
                                "stride": stride,
                                "rowsConsidered": rows,
                                "plausibleIdRows": plausible_rows,
                                "monotonicAfterFirstPlausible": monotonic_rows,
                            }));
                        }
                        Some(json!({
                            "inflatedLength": d.len(),
                            "recordCountFromHeader": record_count,
                            "impliedStride": implied_stride,
                            "strideScores": stride_scores,
                        }))
                    })();
                    let error = match library_outcome {
                        Err(error) => error.to_string(),
                        Ok(_) => "declared ids degenerate (all 0/0xFFFFFFFF) and deterministic re-derivation failed".into(),
                    };
                    let failed_value = json!({
                        "status": "failed", "error": error,
                        "observation": observation,
                    });
                    failures.push(json!({
                        "stage": "elem-table", "error": error,
                        "observation": observation,
                        "note": "record layouts proven on 2023/2024 corpora only; release left fail-closed"
                    }));
                    (BTreeSet::new(), failed_value)
                }
            }
        }
    }
}
