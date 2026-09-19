//! DE26/A08 源级 RVT 统计探针:内置本地读取器,聚合输出,不输出几何网格。
//!
//! 与 rvt-source-identity.rs(2024 身份证据)的区别:本工具按分区流式处理、
//! 不全局累积 inflate 字节,只聚合"实例规则(#211/#212)"命中的类别实例数、
//! bbox 包络、ElemTable 声明元素数,以及 partition 字符串层派生的
//! Level/严格 Material/严格 Room 名候选计数。2024 之外不猜布局:
//! 每个阶段的失败都原样记录,绝不把派生 GLB 统计填进源级空位。
use rvt::partition_name_candidates::{
    classify_name, is_building_storey_name, NameBucket,
};
use rvt::partition_schema_mvp::{is_strict_material_name, is_strict_room_name};
use rvt::partition_element_records as records;
use rvt::{compression, elem_table, object_graph, RevitFile};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use flate2::read::DeflateDecoder;
use std::io::{Read, Write};

const FILE_BUDGET: u64 = 256 * 1024 * 1024;
/// 流式扫描窗口:成员输出按窗口扫描,窗口间携带 64KB 尾部,内存恒定,
/// 远离本环境 ~256MB 的单次分配失败线(r3/r5 实测 "allocation of
/// 268435456 bytes failed" 会直接 abort,无法捕获)。
const SCAN_WINDOW_BYTES: usize = 32 * 1024 * 1024;
const PER_PARTITION_INFLATE_BUDGET: u64 = 1536 * 1024 * 1024;
/// 成员间/窗口间携带的尾部字节:记录头 + 两张引用表实测 ≤ 数 KB,64KB
/// 覆盖跨边界记录,使其在下一窗口按完整字节重新计数(计数前去重)。
const CARRY_BYTES: usize = 64 * 1024;
/// (内置类别, 报告键)与 rvt-source-identity.rs 保持同一 7 类集合。
const CATEGORIES: [(i64, &str); 7] = [
    (records::OST_WALLS, "walls"),
    (records::OST_FLOORS, "floors"),
    (records::OST_COLUMNS, "columns"),
    (records::OST_DOORS, "doors"),
    (records::OST_WINDOWS, "windows"),
    (records::OST_BUILDING_PAD, "buildingPads"),
    (records::OST_SKETCH_LINES, "sketchLines"),
];
const METERS_PER_FOOT: f64 = 0.3048;

type Check<T> = Result<T, Box<dyn std::error::Error>>;

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 头部级验证计数(不主张几何):仅依赖与已证明 2024 形态同位的
/// 头字段(marker/0x59f/类别/placement/container)与 ElemTable id join。
#[derive(Default)]
struct HeaderAgg {
    /// 结构性记录锚点数:类别 + marker 同位,不论 id 是否 join。
    marker_anchor_count: u64,
    record_count: u64,
    placed_record_count: u64,
    symbol_record_count: u64,
    exported_ids: BTreeSet<u32>,
}

/// 一个类别的聚合状态。只存 id → bbox(首个)+冲突标记,不存逐记录 JSON。
#[derive(Default)]
struct CategoryAgg {
    record_count: u64,
    placed_record_count: u64,
    symbol_record_count: u64,
    container_member_record_count: u64,
    exported_record_count: u64,
    exported_ids: BTreeSet<u32>,
    /// 每个导出实例 id 的首个 bbox;重复记录 bbox 不一致时标记冲突。
    first_boxes: BTreeMap<u32, [f64; 6]>,
    ambiguous_ids: BTreeSet<u32>,
    /// 仅头部验证的第二轨道(bbox/引用表未验证,不主张几何)。
    header_rule: HeaderAgg,
}

impl CategoryAgg {
    fn observe(&mut self, record: &records::PartitionElementRecord) {
        self.record_count += 1;
        if record.is_placed_instance() {
            self.placed_record_count += 1;
        }
        if record.is_type_symbol() {
            self.symbol_record_count += 1;
        }
        if record.is_container_member() {
            self.container_member_record_count += 1;
        }
        if !record.is_exported_instance() {
            return;
        }
        self.exported_record_count += 1;
        self.exported_ids.insert(record.element_id);
        match self.first_boxes.get(&record.element_id) {
            None => {
                self.first_boxes.insert(record.element_id, record.bbox_feet);
            }
            Some(existing) if existing != &record.bbox_feet => {
                self.ambiguous_ids.insert(record.element_id);
            }
            Some(_) => {}
        }
    }

    /// 无冲突导出实例的 bbox 并集(源级模型包络的一部分)。
    fn unambiguous_bbox_union(&self) -> Option<[f64; 6]> {
        let mut union: Option<[f64; 6]> = None;
        for (id, bbox) in &self.first_boxes {
            if self.ambiguous_ids.contains(id) {
                continue;
            }
            union = Some(match union {
                None => *bbox,
                Some(current) => {
                    let mut merged = current;
                    for axis in 0..3 {
                        merged[axis] = merged[axis].min(bbox[axis]);
                        merged[axis + 3] = merged[axis + 3].max(bbox[axis + 3]);
                    }
                    merged
                }
            });
        }
        union
    }

    fn to_json(&self, geometry_validated: bool) -> Value {
        let bbox = self.unambiguous_bbox_union();
        json!({
            "recordCount": self.record_count,
            "placedRecordCount": self.placed_record_count,
            "symbolRecordCount": self.symbol_record_count,
            "containerMemberRecordCount": self.container_member_record_count,
            "exportedRecordCount": self.exported_record_count,
            "exportedDistinctIds": self.exported_ids.len(),
            "ambiguousBboxIds": self.ambiguous_ids.len(),
            "unambiguousBboxMinFeet": bbox.map(|b| Vec::from(&b[0..3])),
            "unambiguousBboxMaxFeet": bbox.map(|b| Vec::from(&b[3..6])),
            "geometryValidated": geometry_validated,
            "headerRule": {
                "markerAnchorCount": self.header_rule.marker_anchor_count,
                "recordCount": self.header_rule.record_count,
                "placedRecordCount": self.header_rule.placed_record_count,
                "symbolRecordCount": self.header_rule.symbol_record_count,
                "exportedDistinctIds": self.header_rule.exported_ids.len(),
            },
        })
    }
}

fn union_boxes(current: Option<[f64; 6]>, next: [f64; 6]) -> [f64; 6] {
    match current {
        None => next,
        Some(mut merged) => {
            for axis in 0..3 {
                merged[axis] = merged[axis].min(next[axis]);
                merged[axis + 3] = merged[axis + 3].max(next[axis + 3]);
            }
            merged
        }
    }
}

/// 独立复核记录字节:marker + id/category/container/placement 与解码值一致。
fn verify_record_bytes(
    record: &records::PartitionElementRecord,
    inflated: &[u8],
    declared: &BTreeSet<u32>,
) -> Check<()> {
    let raw = inflated
        .get(record.offset..record.offset.checked_add(136).ok_or("offset overflow")?)
        .ok_or("truncated record")?;
    let id = u64::from_le_bytes(raw[0..8].try_into()?);
    let category = i64::from_le_bytes(raw[18..26].try_into()?);
    if id != u64::from(record.element_id)
        || !declared.contains(&record.element_id)
        || category != record.builtin_category
        || raw[80..88] != records::BBOX_MARKER
    {
        return Err("record identity does not match source bytes / ElemTable".into());
    }
    if u64::from_le_bytes(raw[50..58].try_into()?) != record.container
        || u32::from_le_bytes(raw[66..70].try_into()?) != record.placement_kind
    {
        return Err("record context does not match source bytes".into());
    }
    Ok(())
}

/// 跨成员记录的字节区域是否完整(头部固定 136B + 两张计数引用表)。
/// 与库语义对齐:n=0 或超 REFERENCE_LIST_MAX_ENTRIES 视为该表不存在。
fn reference_area_fits(buf: &[u8], offset: usize) -> bool {
    let mut at = offset + records::RECORD_MIN_LEN;
    let Some(len1) = buf.get(at..at + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap())) else {
        return false;
    };
    if len1 == 0 || len1 as usize > records::REFERENCE_LIST_MAX_ENTRIES {
        return true; // 第一表不存在:库对 owner 也返回 None,区域到此为止。
    }
    at += 4 + len1 as usize * 8;
    let Some(len2) = buf.get(at..at + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap())) else {
        return false; // 第二表长度前缀被截断:跳过,等下一轮携带区补全。
    };
    if len2 == 0 || len2 as usize > records::REFERENCE_LIST_MAX_ENTRIES {
        return at + 4 <= buf.len();
    }
    at + 4 + len2 as usize * 8 <= buf.len()
}

/// 头部级记录验证(仅计数,不主张几何):字段与已证明 2024 形态同位
/// (+0x10 零、+0x12 类别、+0x50 bbox marker;+0x0c 在单语料外不恒定,不作校验),
/// id-join(declared)由调用方按轨道执行;bbox 与引用表不做任何解释。
fn validate_record_header(
    buf: &[u8],
    offset: usize,
    category: i64,
) -> Option<records::PartitionElementRecord> {
    if offset + 0x58 > buf.len() {
        return None;
    }
    if u16::from_le_bytes(buf[offset + 0x10..offset + 0x12].try_into().ok()?) != 0 {
        return None;
    }
    if i64::from_le_bytes(buf[offset + 0x12..offset + 0x1a].try_into().ok()?) != category {
        return None;
    }
    if buf[offset + 0x50..offset + 0x58] != records::BBOX_MARKER {
        return None;
    }
    let raw_id = u64::from_le_bytes(buf[offset..offset + 8].try_into().ok()?);
    if raw_id == 0 {
        return None;
    }
    // 头部以外的字段保持原始值,不参与任何几何/引用主张。id-join 由调用方
    // 按轨道区分:计数轨道要求 declared,结构锚点轨道只要求 u32 可表示。
    Some(records::PartitionElementRecord {
        stream: String::new(),
        offset,
        element_id: u32::try_from(raw_id).unwrap_or(0),
        flags: 0,
        builtin_category: category,
        container: u64::from_le_bytes(buf[offset + 0x32..offset + 0x3a].try_into().ok()?),
        placement_kind: u32::from_le_bytes(buf[offset + 0x42..offset + 0x46].try_into().ok()?),
        bbox_feet: [0.0; 6],
        references: Vec::new(),
        preceding_reference: None,
        owner_reference: None,
    })
}



/// 对一条已准备流的每个 gzip 成员做流式解码并按窗口扫描。
///
/// 解码语义与 `compression::inflate_at_with_limits` 一致(同一公开
/// `gzip_header_len` + 同一 `flate2::read::DeflateDecoder`),差别只在输出
/// 按 SCAN_WINDOW_BYTES 窗口分批交给 `visit`,窗口间携带 CARRY_BYTES
/// 尾部,因此单个成员的输出再大也不会触发一次性大分配。返回解码总字节。
fn scan_stream_windowed(
    prepared: &[u8],
    mut visit: impl FnMut(&[u8], u64),
    mut member_error: impl FnMut(u64),
) -> u64 {
    let mut total = 0u64;
    for offset in compression::find_gzip_offsets(prepared) {
        let Some(header_len) = compression::gzip_header_len(prepared, offset) else {
            member_error(offset as u64);
            continue;
        };
        let Some(body) = prepared.get(offset + header_len..) else {
            member_error(offset as u64);
            continue;
        };
        let mut decoder = DeflateDecoder::new(body);
        let mut carry: Vec<u8> = Vec::new();
        let mut consumed: u64 = 0;
        let mut buf = vec![0u8; SCAN_WINDOW_BYTES];
        loop {
            let n = match decoder.read(&mut buf) {
                Ok(n) => n,
                Err(_) => {
                    member_error(offset as u64);
                    break;
                }
            };
            if n == 0 {
                break;
            }
            let mut window = Vec::with_capacity(carry.len() + n);
            window.extend_from_slice(&carry);
            window.extend_from_slice(&buf[..n]);
            let window_base = consumed.saturating_sub(carry.len() as u64);
            visit(&window, window_base);
            consumed += n as u64;
            let start = window.len().saturating_sub(CARRY_BYTES);
            carry = window[start..].to_vec();
        }
        total += consumed;
    }
    total
}

/// 逐分区流式扫描类别记录;窗口化解码,单分区超出预算时精确记录。
fn scan_partitions(
    rf: &mut RevitFile,
    declared: &BTreeSet<u32>,
    categories: &mut BTreeMap<&'static str, CategoryAgg>,
    sketch_owners: &mut BTreeSet<u32>,
    partition_reports: &mut Vec<Value>,
) -> Check<()> {
    let mut paths: Vec<String> = rf
        .stream_names()
        .into_iter()
        .filter(|s| s.starts_with("Partitions/"))
        .collect();
    paths.sort();
    if paths.is_empty() {
        return Err("missing partitions".into());
    }
    for path in paths {
        let raw = rf.read_stream(&path)?;
        let prepared = compression::prepare_stream_for_inflate(&path, &raw);
        let mut seen: BTreeSet<u64> = BTreeSet::new();
        let mut header_seen: BTreeSet<u64> = BTreeSet::new();
        let mut scanned = 0u64;
        let mut undecodable: Vec<u64> = Vec::new();
        let inflated_total = {
            let seen = &mut seen;
            let header_seen = &mut header_seen;
            let scanned = &mut scanned;
            let undecodable = &mut undecodable;
            scan_stream_windowed(
                &prepared,
                |window, window_base| {
                    for (category_id, key) in CATEGORIES {
                        let Some(agg) = categories.get_mut(key) else { continue };
                        // 第二轨道:头部级验证计数(见 validate_record_header)。
                        let mut le = [0u8; 8];
                        le.copy_from_slice(&category_id.to_le_bytes());
                        let mut from = 0usize;
                        while let Some(rel) = window[from..].windows(8).position(|w| w == le) {
                            let at = from + rel;
                            from = at + 1;
                            let Some(rs) = at.checked_sub(records::CATEGORY_OFFSET) else { continue };
                            let absolute = window_base + rs as u64;
                            if header_seen.contains(&absolute) {
                                continue;
                            }
                            let Some(facts) =
                                validate_record_header(window, rs, category_id)
                            else {
                                continue;
                            };
                            header_seen.insert(absolute);
                            let header = &mut agg.header_rule;
                            header.marker_anchor_count += 1;
                            if facts.element_id == 0
                                || !declared.contains(&facts.element_id)
                            {
                                continue; // id 不在 ElemTable:只计锚点,不计实例。
                            }
                            header.record_count += 1;
                            if facts.is_placed_instance() {
                                header.placed_record_count += 1;
                            }
                            if facts.is_type_symbol() {
                                header.symbol_record_count += 1;
                            }
                            if facts.is_exported_instance() {
                                header.exported_ids.insert(facts.element_id);
                            }
                        }
                        for record in
                            records::find_category_records(&path, window, category_id, declared)
                        {
                            let absolute = window_base + record.offset as u64;
                            // 已在上一窗口计数过的记录按绝对偏移去重;
                            // 跨边界截断记录未计数,等本窗口按完整字节计数。
                            if seen.contains(&absolute) {
                                continue;
                            }
                            // sketch 行需要两张引用表完整才能取 owner;
                            // 其余类别只依赖已验证的 136B 头。
                            if category_id == records::OST_SKETCH_LINES
                                && !reference_area_fits(window, record.offset)
                            {
                                continue;
                            }
                            if verify_record_bytes(&record, window, declared).is_err() {
                                continue;
                            }
                            seen.insert(absolute);
                            agg.observe(&record);
                            *scanned += 1;
                            if category_id == records::OST_SKETCH_LINES {
                                if let Some(owner) = record.owner_reference {
                                    if owner != 0 {
                                        sketch_owners.insert(owner);
                                    }
                                }
                            }
                        }
                    }
                },
                |offset| undecodable.push(offset),
            )
        };
        let budget_exceeded = inflated_total > PER_PARTITION_INFLATE_BUDGET;
        let status = if budget_exceeded {
            "partial-inflate-budget-exceeded"
        } else if !undecodable.is_empty() {
            "partial-undecodable-members"
        } else {
            "scanned"
        };
        partition_reports.push(json!({
            "path": path,
            "storedBytes": prepared.len(),
            "inflatedBytes": inflated_total,
            "categoryRecordsScanned": scanned,
            "undecodableMemberOffsets": undecodable,
            "status": status,
        }));
        eprintln!("stage: partition {path} scanned={scanned} inflated={inflated_total} status={status}");
    }
    Ok(())
}


/// 逐成员提取字符串记录(与 object_graph::string_records_from_partitions
/// 同流同提取规则,分块以限制内存),名称按库的同一分类规则增量收集。
struct StringScan {
    record_count: u64,
    name_set: BTreeSet<(NameBucket, String)>,
    undecodable: Vec<u64>,
}

fn scan_strings(rf: &mut RevitFile, partition: &str) -> Check<StringScan> {
    let raw = rf.read_stream(partition)?;
    let prepared = compression::prepare_stream_for_inflate(partition, &raw);
    let mut scan = StringScan {
        record_count: 0,
        name_set: BTreeSet::new(),
        undecodable: Vec::new(),
    };
    let mut seen: BTreeSet<u64> = BTreeSet::new();
    // 单个坏成员只记失败并跳过,不放弃整个流(库的 recover 路径对
    // 字符串扫描失败是 unwrap_or_default 整体放弃;这里保留部分结果
    // 并在报告中标注完整性)。
    {
        let seen = &mut seen;
        let scan = &mut scan;
        scan_stream_windowed(
            &prepared,
            |window, window_base| {
                for record in object_graph::extract_string_records(window) {
                    let absolute = window_base + record.offset as u64;
                    if !seen.insert(absolute) {
                        continue;
                    }
                    scan.record_count += 1;
                    if let Some(bucket) = classify_name(&record.value) {
                        scan.name_set.insert((bucket, record.value.trim().to_string()));
                    }
                }
            },
            |offset| scan.undecodable.push(offset),
        );
    }
    Ok(scan)
}

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

fn inspect_elem_table(
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

fn inspect(bytes: Vec<u8>) -> Check<Value> {
    let source_sha = hash(&bytes);
    let source_bytes = bytes.len();
    let mut rf = RevitFile::open_bytes(bytes)?;
    let bfi = rf.basic_file_info()?;
    let version = bfi.version;
    let mut failures: Vec<Value> = Vec::new();

    // --- 阶段 1:ElemTable(2024 已证明 40 字节 framing;其余版本如实记录) ---
    let (declared, elem_table_json) = inspect_elem_table(&mut rf, version, &mut failures);

    // --- 阶段 2:partition element records(仅 2024,fail closed)---
    let mut categories: BTreeMap<&'static str, CategoryAgg> =
        CATEGORIES.iter().map(|(_, key)| (*key, CategoryAgg::default())).collect();
    let mut sketch_owners: BTreeSet<u32> = BTreeSet::new();
    let mut partition_reports: Vec<Value> = Vec::new();
    let mut partition_stage = json!({"status": "skipped", "supportedRevitVersions": records::PARTITION_ELEMENT_RECORD_SUPPORTED_REVIT_VERSIONS});
    if !records::supports_revit_version(version) {
        failures.push(json!({
            "stage": "partition-element-records",
            "error": format!("record shape proven on {:?} only; release {} left fail-closed",
                records::PARTITION_ELEMENT_RECORD_SUPPORTED_REVIT_VERSIONS, version),
            "note": "container/basicFileInfo/string stages still measured below"
        }));
    } else if declared.is_empty() {
        failures.push(json!({
            "stage": "partition-element-records",
            "error": "no declared ElemTable ids; the record scan requires the ElemTable join"
        }));
    } else {
        match scan_partitions(&mut rf, &declared, &mut categories, &mut sketch_owners, &mut partition_reports) {
            Ok(()) => {
                let complete = partition_reports.iter().all(|p| p["status"] == "scanned");
                partition_stage = json!({
                    "status": if complete { "measured" } else { "partial-coverage" },
                    "supportedRevitVersions": records::PARTITION_ELEMENT_RECORD_SUPPORTED_REVIT_VERSIONS,
                    "partitions": partition_reports,
                });
            }
            Err(error) => {
                failures.push(json!({"stage": "partition-element-records", "error": error.to_string()}));
                partition_stage = json!({
                    "status": "failed", "error": error.to_string(),
                    "partitions": partition_reports,
                });
            }
        }
    }

    // --- 阶段 3:partition 字符串层(库内同一 MVP 候选规则;跨版本启发)---
    // 与 object_graph::string_records_from_partitions 相同的流选择与提取
    // 规则,但逐成员连接扫描(64KB 尾部携带 + 绝对偏移去重),名称按
    // classify_name/is_building_storey_name 增量收集,避免一次性大缓冲
    // 在本环境触发 256MB 单次分配 abort。库的一次性拼接会在成员之间垫
    // 16 字节 0xFF 分隔(跨成员记录丢失);本实现改为携带区补全,跨成员
    // 记录可被完整恢复,属于同一规则下更完备的切分方式。
    let strings_json = match rf.partition_stream_name() {
        Some(partition) => match scan_strings(&mut rf, &partition) {
            Ok(scan) => {
                let level_names: BTreeSet<String> = scan
                    .name_set
                    .iter()
                    .filter(|(bucket, name)| {
                        *bucket == NameBucket::LevelLike && is_building_storey_name(name)
                    })
                    .map(|(_, name)| name.clone())
                    .collect();
                let materials: Vec<String> = scan
                    .name_set
                    .iter()
                    .filter(|(bucket, name)| {
                        *bucket == NameBucket::MaterialLike && is_strict_material_name(name)
                    })
                    .map(|(_, name)| name.clone())
                    .collect();
                let rooms: Vec<String> = scan
                    .name_set
                    .iter()
                    .filter(|(bucket, name)| {
                        *bucket == NameBucket::SpaceLike && is_strict_room_name(name)
                    })
                    .map(|(_, name)| name.clone())
                    .collect();
                json!({
                    "status": "measured",
                    "partitionStream": partition,
                    "extraction": "object_graph::extract_string_records per member with 64KB carry-tail; classification = partition_name_candidates::classify_name + is_building_storey_name + partition_schema_mvp strict material/room filters (same rule as partition_schema_mvp::recover_partition_schema_mvp, chunked for bounded memory)",
                    "stringRecords": scan.record_count,
                    "undecodableMemberOffsets": scan.undecodable,
                    "nameCandidates": scan.name_set.len(),
                    "levelDistinctNames": level_names.len(),
                    "levelNames": level_names,
                    "strictMaterialNames": materials,
                    "strictRoomNames": rooms,
                })
            }
            Err(error) => {
                failures.push(json!({"stage": "partition-strings", "error": error.to_string()}));
                json!({"status": "failed", "error": error.to_string()})
            }
        },
        None => {
            failures.push(json!({"stage": "partition-strings", "error": "no Partitions/NN stream"}));
            json!({"status": "failed", "error": "no Partitions/NN stream"})
        }
    };

    // --- 聚合源级统计 ---
    // 双轨道语义:
    // - headerRule:仅头部验证(2024 同位头字段 + declared id join)的实例
    //   计数,不主张任何几何;2 个不可解码成员存在时是下界。
    // - strict(bbx):decode_at 全量验证(含 bbox)的子集;只有当某类别
    //   strict == header 时,该类别的 bbox 才作为"几何已验证"参与包络。
    let mut model_box: Option<[f64; 6]> = None;
    let mut bbox_fully_validated = true;
    let mut category_json = serde_json::Map::new();
    let mut exported_totals = serde_json::Map::new();
    let mut strict_totals = serde_json::Map::new();
    for (key, agg) in &categories {
        // 几何已验证 = 结构性记录几乎全部通过全量解码(bbox/引用解释成立);
        // 只要大量锚点被 bbox 校验拒绝,该类别就不出具几何主张。
        let geometry_validated = agg.header_rule.marker_anchor_count == 0
            || agg.record_count * 100 >= agg.header_rule.marker_anchor_count * 95;
        if *key != "sketchLines" {
            if geometry_validated {
                if let Some(bbox) = agg.unambiguous_bbox_union() {
                    model_box = Some(union_boxes(model_box, bbox));
                }
            } else {
                bbox_fully_validated = false;
            }
            exported_totals.insert(key.to_string(), json!(agg.header_rule.exported_ids.len()));
            strict_totals.insert(key.to_string(), json!(agg.exported_ids.len()));
        }
        category_json.insert((*key).to_string(), agg.to_json(geometry_validated));
    }
    let instances_measured = exported_totals.values().any(|v| v.as_u64().unwrap_or(0) > 0);
    let geometry = if instances_measured && bbox_fully_validated {
        "aggregate-source-statistics"
    } else if instances_measured {
        "instance-counts-only"
    } else {
        "missing"
    };
    let mut unmeasured = vec!["triangles", "meshes", "textures"];
    if !bbox_fully_validated {
        unmeasured.push("sourceModelBBox");
    }
    let statistics = json!({
        "units": {"internal": "revit-feet", "metersPerFoot": METERS_PER_FOOT},
        "declaredElementIds": if declared.is_empty() { Value::Null } else { json!(declared.len()) },
        "exportedInstanceIds": exported_totals,
        "exportedInstanceIdsGeometryValidated": strict_totals,
        "sketchOwnerDistinctIds": sketch_owners.len(),
        "levelDistinctNames": strings_json["levelDistinctNames"].clone(),
        "strictMaterialNameCount": strings_json["strictMaterialNames"].as_array().map(|a| a.len()).unwrap_or(0),
        "strictRoomNameCount": strings_json["strictRoomNames"].as_array().map(|a| a.len()).unwrap_or(0),
        "modelBBoxMinFeet": model_box.map(|b| Vec::from(&b[0..3])),
        "modelBBoxMaxFeet": model_box.map(|b| Vec::from(&b[3..6])),
        "modelBBoxMinMeters": model_box.map(|b| b[0..3].iter().map(|v| v * METERS_PER_FOOT).collect::<Vec<_>>()),
        "modelBBoxMaxMeters": model_box.map(|b| b[3..6].iter().map(|v| v * METERS_PER_FOOT).collect::<Vec<_>>()),
        "modelBBoxBoundary": if bbox_fully_validated { "bbox validated on every counted instance" } else { "bbox wire layout unproven on this save; envelope withheld" },
        "unmeasured": unmeasured,
        "unmeasuredReason": "builtin local reader has no tessellation for these releases; derived GLB counts are not substituted",
    });

    let status = if failures.iter().any(|f| f["stage"] == "partition-element-records") {
        // 版本门控/布局未证明的失败优先表达:该 release 的 partition 记录
        // 路径 fail-closed,只有容器/ElemTable/字符串层被测量。
        "unsupported-version"
    } else if instances_measured || bbox_fully_validated {
        "measured"
    } else {
        "partially-inspected"
    };

    Ok(json!({
        "schemaVersion": 1,
        "scope": "source-statistics-aggregate",
        "quality": "inspect",
        "tool": "scripts/fixtures/rvt-source-statistics.rs",
        "reader": "rvt-rs vendored copy, offline Cargo.lock build (see evidence.json files)",
        "sourceSha256": source_sha,
        "sourceBytes": source_bytes,
        "revitVersion": version,
        "build": bfi.build,
        "guid": bfi.guid,
        "locale": bfi.locale,
        "originalPath": Value::Null,
        "originalPathNote": "redacted; creator filesystem path is PII",
        "status": status,
        "geometry": geometry,
        "elemTable": elem_table_json,
        "partitionElementRecords": partition_stage,
        "partitionStrings": strings_json,
        "categories": category_json,
        "statistics": statistics,
        "failures": failures,
        "instanceRule": "records::PartitionElementRecord::is_exported_instance (#211/#212, RE-21/RE-22 corpus measurement)",
    }))
}

fn main() -> Check<()> {
    let mut args = std::env::args().skip(1);
    let input = args.next().ok_or("usage: rvt-source-statistics input.rvt output.json")?;
    let output = args.next().ok_or("missing output")?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    let file = std::fs::File::open(&input)?;
    let size = file.metadata()?.len();
    if size > FILE_BUDGET {
        return Err("source exceeds research budget".into());
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(size + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != size {
        return Err("source changed size while reading".into());
    }
    let report = inspect(bytes)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?
        .write_all(&serde_json::to_vec_pretty(&report)?)?;
    println!(
        "{}",
        json!({
            "status": report["status"],
            "version": report["revitVersion"],
            "declaredElementIds": report["statistics"]["declaredElementIds"],
            "exportedInstanceIds": report["statistics"]["exportedInstanceIds"],
            "strictMaterialNameCount": report["statistics"]["strictMaterialNameCount"],
            "levelDistinctNames": report["statistics"]["levelDistinctNames"],
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: u32, container: u64, placement: u32, bbox: [f64; 6]) -> records::PartitionElementRecord {
        records::PartitionElementRecord {
            stream: "Partitions/1".into(),
            offset: 0,
            element_id: id,
            flags: 0,
            builtin_category: records::OST_WALLS,
            container,
            placement_kind: placement,
            bbox_feet: bbox,
            references: Vec::new(),
            preceding_reference: None,
            owner_reference: None,
        }
    }

    #[test]
    fn instance_rule_and_counts_follow_the_record_test() {
        let mut agg = CategoryAgg::default();
        let placement_instance = records::PLACEMENT_KIND_INSTANCE;
        let placement_symbol = records::PLACEMENT_KIND_SYMBOL;
        let none = records::CONTAINER_NONE;
        agg.observe(&record(1, none, placement_instance, [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]));
        // 同 id 同 bbox 的重复记录不冲突。
        agg.observe(&record(1, none, placement_instance, [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]));
        // 类型符号与容器成员都不进导出实例。
        agg.observe(&record(2, none, placement_symbol, [-1.0, -1.0, 0.0, 1.0, 1.0, 1.0]));
        agg.observe(&record(3, 42, placement_instance, [0.0, 0.0, 0.0, 2.0, 2.0, 2.0]));
        assert_eq!(agg.record_count, 4);
        assert_eq!(agg.exported_ids, BTreeSet::from([1]));
        assert_eq!(agg.exported_record_count, 2);
        assert_eq!(agg.symbol_record_count, 1);
        assert_eq!(agg.container_member_record_count, 1);
        assert_eq!(agg.unambiguous_bbox_union(), Some([0.0, 0.0, 0.0, 1.0, 1.0, 1.0]));
    }

    #[test]
    fn conflicting_duplicate_bbox_is_marked_ambiguous() {
        let mut agg = CategoryAgg::default();
        let none = records::CONTAINER_NONE;
        agg.observe(&record(7, none, records::PLACEMENT_KIND_INSTANCE, [0.0; 6]));
        agg.observe(&record(7, none, records::PLACEMENT_KIND_INSTANCE, [1.0; 6]));
        assert!(agg.ambiguous_ids.contains(&7));
        assert_eq!(agg.unambiguous_bbox_union(), None);
    }

    #[test]
    fn union_boxes_takes_componentwise_min_max() {
        let merged = union_boxes(Some([0.0, -1.0, 2.0, 4.0, 5.0, 6.0]), [1.0, 0.0, 3.0, 3.0, 4.0, 9.0]);
        assert_eq!(merged, [0.0, -1.0, 2.0, 4.0, 5.0, 9.0]);
        assert_eq!(union_boxes(None, [1.0; 6]), [1.0; 6]);
    }

    #[test]
    fn verify_record_bytes_rejects_bad_marker() {
        let mut b = vec![255u8; 144];
        b[0..8].copy_from_slice(&42u64.to_le_bytes());
        b[16..18].fill(0);
        b[18..26].copy_from_slice(&records::OST_WALLS.to_le_bytes());
        b[50..58].copy_from_slice(&records::CONTAINER_NONE.to_le_bytes());
        b[66..70].copy_from_slice(&records::PLACEMENT_KIND_INSTANCE.to_le_bytes());
        b[80..88].copy_from_slice(&records::BBOX_MARKER);
        for (i, v) in [0f64, 0., 0., 1., 1., 1.].iter().enumerate() {
            b[88 + i * 8..96 + i * 8].copy_from_slice(&v.to_le_bytes());
        }
        b[136..140].fill(0);
        let decoded = records::decode_at("Partitions/1", &b, 0, &BTreeSet::from([42])).unwrap();
        assert!(verify_record_bytes(&decoded, &b, &BTreeSet::from([42])).is_ok());
        b[80] = 0;
        assert!(verify_record_bytes(&decoded, &b, &BTreeSet::from([42])).is_err());
    }

    #[test]
    fn malformed_input_is_rejected() {
        assert!(inspect(vec![0; 512]).is_err());
    }
}
