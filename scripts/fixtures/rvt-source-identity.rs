//! RVT 2024 源身份研究检查；不输出几何，不开放产品 profile。
use rvt::{RevitFile, compression, elem_table, partition_element_records as records};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};

const FILE_BUDGET: u64 = 256 * 1024 * 1024;
const INFLATE_BUDGET: usize = 256 * 1024 * 1024;
const CATEGORIES: [i64; 7] = [
    records::OST_WALLS,
    records::OST_FLOORS,
    records::OST_COLUMNS,
    records::OST_DOORS,
    records::OST_WINDOWS,
    records::OST_BUILDING_PAD,
    records::OST_SKETCH_LINES,
];
type Check<T> = Result<T, Box<dyn std::error::Error>>;

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn identity(source: &str, id: u32) -> String {
    format!("rvt:{source}:element:{id}")
}

/// 独立读取字段，不把 reader 返回的身份直接当作源证明。
fn verify_record(
    record: &records::PartitionElementRecord,
    bytes: &[u8],
    declared: &BTreeSet<u32>,
) -> Check<String> {
    let raw = bytes
        .get(record.offset..record.offset.checked_add(136).ok_or("offset overflow")?)
        .ok_or("truncated record")?;
    let id = u64::from_le_bytes(raw[0..8].try_into()?);
    let category = i64::from_le_bytes(raw[18..26].try_into()?);
    if id != u64::from(record.element_id)
        || !declared.contains(&record.element_id)
        || category != record.builtin_category
        || raw[80..88] != [0x46, 1, 255, 255, 255, 255, 0xab, 5]
    {
        return Err("record identity does not match source bytes / ElemTable".into());
    }
    if u64::from_le_bytes(raw[50..58].try_into()?) != record.container
        || u32::from_le_bytes(raw[66..70].try_into()?) != record.placement_kind
    {
        return Err("record context does not match source bytes".into());
    }
    for (axis, expected) in record.bbox_feet.iter().enumerate() {
        let value = f64::from_le_bytes(raw[88 + axis * 8..96 + axis * 8].try_into()?);
        if !value.is_finite() || value.to_bits() != expected.to_bits() {
            return Err("bbox source mismatch".into());
        }
    }
    Ok(hash(raw))
}

fn insert_record(map: &mut BTreeMap<u32, Vec<Value>>, id: u32, value: Value) {
    map.entry(id).or_default().push(value);
}

fn verify_table_row(row: &elem_table::ElemRecord) -> Check<()> {
    if row.raw.len() != 40
        || u32::from_le_bytes(row.raw[16..20].try_into()?) != row.id_primary
        || u32::from_le_bytes(row.raw[36..40].try_into()?) != row.id_secondary
    {
        return Err("unverified ElemTable record layout".into());
    }
    Ok(())
}

fn inspect(bytes: Vec<u8>) -> Check<Value> {
    let source = hash(&bytes);
    let mut rf = RevitFile::open_bytes(bytes)?;
    let version = rf.basic_file_info()?.version;
    let mut report = json!({"schemaVersion":1,"quality":"inspect","geometry":"missing",
        "sourceSha256":source,"revitVersion":version,"profile":"rvt-2024-partition-record-identity",
        "coverage":"selected-category-record-candidates-not-all-model-elements",
        "identityScope":"source-snapshot-not-cross-revision","elements":[],"streams":[]});
    if version != 2024 {
        report["status"] = json!("unsupported-version");
        return Ok(report);
    }
    let table = elem_table::parse_records(&mut rf)?;
    let mut declared = BTreeSet::new();
    let mut table_rows: BTreeMap<u32, Vec<Value>> = BTreeMap::new();
    for row in &table {
        // 当前只接受 2024 已证明的 40-byte framing；不猜其它布局。
        verify_table_row(row)?;
        declared.insert(row.id_primary);
        table_rows.entry(row.id_primary).or_default().push(
            json!({"offset":row.offset,"sha256":hash(&row.raw),"secondaryIdRaw":row.id_secondary,
                "uninterpretedSlotRaw":u64::from_le_bytes(row.raw[4..12].try_into()?).to_string()}),
        );
    }
    if declared.is_empty() {
        return Err("empty declared element index".into());
    }
    let mut paths: Vec<_> = rf
        .stream_names()
        .into_iter()
        .filter(|s| s.starts_with("Partitions/"))
        .collect();
    paths.sort();
    if paths.is_empty() {
        return Err("missing partitions".into());
    }
    let mut indexed = BTreeMap::new();
    let mut streams = Vec::new();
    for path in paths {
        let raw = rf.read_stream(&path)?;
        let prepared = compression::prepare_stream_for_inflate(&path, &raw);
        let mut inflated = Vec::new();
        let mut failed_offsets = Vec::new();
        let mut members = Vec::new();
        for offset in compression::find_gzip_offsets(&prepared) {
            match compression::inflate_at_with_limits(
                &prepared,
                offset,
                compression::InflateLimits {
                    max_output_bytes: INFLATE_BUDGET.saturating_sub(inflated.len()),
                },
            ) {
                Ok(chunk) => {
                    members.push(json!({"preparedOffset":offset,"inflatedOffset":inflated.len(),"length":chunk.len(),"sha256":hash(&chunk)}));
                    inflated.extend(chunk);
                }
                Err(_) => failed_offsets.push(offset),
            }
        }
        if inflated.is_empty() {
            return Err(format!("no decodable partition bytes: {path}").into());
        }
        for category in CATEGORIES {
            for record in records::find_category_records(&path, &inflated, category, &declared) {
                let header_hash = verify_record(&record, &inflated, &declared)?;
                let references = records::decode_reference_list(&inflated, record.offset + 136);
                insert_record(
                    &mut indexed,
                    record.element_id,
                    json!({
                        "stream":path,"inflatedOffset":record.offset,"headerSha256":header_hash,
                        "categoryId":record.builtin_category,"containerRaw":record.container.to_string(),
                        "placementKindRaw":record.placement_kind,"bboxDiagnosticFeet":record.bbox_feet,
                        "referencesRaw":references,"relationSemantics":"unknown"
                    }),
                );
            }
        }
        streams.push(
            json!({"path":path,"storedSha256":hash(&raw),"inflatedSha256":hash(&inflated),
            "inflatedBytes":inflated.len(),"members":members,"undecodedMagicOffsets":failed_offsets,
            "completeness":"unverified"}),
        );
    }
    let mut elements = Vec::new();
    for (id, mut evidence) in indexed {
        evidence.sort_by_key(|v| {
            (
                v["stream"].as_str().unwrap().to_owned(),
                v["inflatedOffset"].as_u64().unwrap(),
            )
        });
        // 多记录可能是版本或冲突，不选择 first/last 胜出。
        let state = if evidence.len() == 1 {
            "single-record"
        } else {
            "ambiguous-multiple-records"
        };
        elements.push(
            json!({"sourceId":identity(&source,id),"elementId":id,"status":state,
            "elemTable":table_rows.get(&id),"records":evidence}),
        );
    }
    report["status"] = json!("identity-candidates");
    report["declaredElementIds"] = json!(declared.len());
    report["elements"] = json!(elements);
    report["streams"] = json!(streams);
    Ok(report)
}

fn main() -> Check<()> {
    let mut args = std::env::args().skip(1);
    let input = args
        .next()
        .ok_or("usage: rvt-source-identity input.rvt output.json")?;
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
        .open(output)?
        .write_all(&serde_json::to_vec_pretty(&report)?)?;
    println!(
        "{}",
        json!({"status":report["status"],"elements":report["elements"].as_array().unwrap().len(),"quality":"inspect"})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Vec<u8>, records::PartitionElementRecord, BTreeSet<u32>) {
        let mut b = vec![255; 144];
        b[0..8].copy_from_slice(&42u64.to_le_bytes());
        b[16..18].fill(0);
        b[18..26].copy_from_slice(&records::OST_WALLS.to_le_bytes());
        b[80..88].copy_from_slice(&[0x46, 1, 255, 255, 255, 255, 0xab, 5]);
        for (i, v) in [0f64, 0., 0., 1., 1., 1.].iter().enumerate() {
            b[88 + i * 8..96 + i * 8].copy_from_slice(&v.to_le_bytes());
        }
        b[136..140].fill(0);
        let declared = BTreeSet::from([42]);
        let record = records::decode_at("Partitions/1", &b, 0, &declared).unwrap();
        (b, record, declared)
    }
    #[test]
    fn matches_bytes_and_rejects_identity_swap() {
        let (b, mut r, d) = fixture();
        assert!(verify_record(&r, &b, &d).is_ok());
        r.element_id = 43;
        assert!(verify_record(&r, &b, &BTreeSet::from([42, 43])).is_err());
    }
    #[test]
    fn rejects_truncation_unknown_id_and_changed_context() {
        let (mut b, r, d) = fixture();
        assert!(verify_record(&r, &b[..135], &d).is_err());
        assert!(verify_record(&r, &b, &BTreeSet::new()).is_err());
        b[50] = 0;
        assert!(verify_record(&r, &b, &d).is_err());
    }
    #[test]
    fn duplicate_records_are_retained_not_overwritten() {
        let mut map = BTreeMap::new();
        insert_record(&mut map, 42, json!({"offset":1}));
        insert_record(&mut map, 42, json!({"offset":2}));
        assert_eq!(map[&42].len(), 2);
    }
    #[test]
    fn identity_namespaces_snapshots_and_ignores_traversal_order() {
        assert_eq!(identity("abc", 42), identity("abc", 42));
        assert_ne!(identity("abc", 42), identity("def", 42));
        assert_ne!(identity("abc", 42), identity("abc", 43));
    }
    #[test]
    fn malformed_container_is_rejected() {
        assert!(inspect(vec![0; 512]).is_err());
    }
    #[test]
    fn table_ids_follow_2024_offsets_and_reject_wrong_slots() {
        let mut raw = vec![0; 40];
        raw[4..12].fill(255);
        raw[16..20].copy_from_slice(&42u32.to_le_bytes());
        raw[36..40].copy_from_slice(&42u32.to_le_bytes());
        let mut row = elem_table::ElemRecord {
            offset: 30,
            id_primary: 42,
            id_secondary: 42,
            raw,
        };
        assert!(verify_table_row(&row).is_ok());
        row.raw.swap(12, 16);
        assert!(verify_table_row(&row).is_err());
    }
}
