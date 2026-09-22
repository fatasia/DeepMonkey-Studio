//! Raw length-framed geometry records joined to a selected standalone source ID.
use rvt::{RevitFile, compression, partition_element_records as records};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Write;
fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("input.rvt element-id new-output.json".into());
    }
    let selected: Option<u32> = if args[1] == "all" {
        None
    } else {
        Some(args[1].parse()?)
    };
    let input = std::fs::read(&args[0])?;
    if input.len() > 256 * 1024 * 1024 {
        return Err("source budget".into());
    }
    let source = sha(&input);
    let mut rf = RevitFile::open_bytes(input)?;
    if rf.basic_file_info()?.version != 2024 {
        return Err("unsupported version".into());
    }
    let declared: BTreeSet<_> = rvt::elem_table::parse_records(&mut rf)?
        .iter()
        .map(|r| r.id_primary)
        .collect();
    if selected.is_some_and(|id| !declared.contains(&id)) {
        return Err("undeclared source ID".into());
    }
    let mut metadata = Vec::new();
    let mut geometry = Vec::new();
    for path in rf
        .stream_names()
        .into_iter()
        .filter(|s| s.starts_with("Partitions/"))
    {
        let raw = rf.read_stream(&path)?;
        let prepared = compression::prepare_stream_for_inflate(&path, &raw);
        let mut bytes = Vec::new();
        for at in compression::find_gzip_offsets(&prepared) {
            bytes.extend(compression::inflate_at_with_limits(
                &prepared,
                at,
                compression::InflateLimits {
                    max_output_bytes: 256 * 1024 * 1024 - bytes.len(),
                },
            )?);
        }
        for category in [records::OST_FLOORS, records::OST_BUILDING_PAD] {
            for r in records::find_category_records(&path, &bytes, category, &declared)
                .into_iter()
                .filter(|r| selected.is_none_or(|id| r.element_id == id))
            {
                let mut value = json!({"stream":path,"offset":r.offset,"category":category,
                "containerRaw":r.container.to_string(),"placementKindRaw":r.placement_kind,"standalone":r.is_exported_instance(),
                "recordHeaderSha256":sha(&bytes[r.offset..r.offset+136]),"bboxDiagnosticFeet":r.bbox_feet});
                if selected.is_none() {
                    value["element"] = json!(r.element_id);
                }
                metadata.push(value);
            }
        }
        for (at, w) in bytes.windows(8).enumerate() {
            let raw_id = u64::from_le_bytes(w.try_into()?);
            if raw_id > u64::from(u32::MAX)
                || !declared.contains(&(raw_id as u32))
                || selected.is_some_and(|id| raw_id != u64::from(id))
            {
                continue;
            }
            let Some(header) = bytes.get(at..at + 20) else {
                continue;
            };
            if header[16..18] != [0x3f, 8] {
                continue;
            }
            let length = u32::from_le_bytes(header[12..16].try_into()?) as usize;
            if length > 1024 * 1024 {
                continue;
            }
            let end = at + 16 + length;
            let Some(record) = bytes.get(at..end + 4) else {
                continue;
            };
            if record[record.len() - 4..] != header[12..16] {
                continue;
            }
            let mut value =
                json!({"stream":path,"offset":at,"recordBytes":record.len(),"sha256":sha(record)});
            if selected.is_none() {
                value["carrierHex"] = json!(
                    header[16..20]
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                );
            }
            if selected.is_some() || [3704, 22997].contains(&record.len()) {
                value["hex"] = json!(
                    record
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                );
            }
            if selected.is_none() {
                value["element"] = json!(raw_id);
            }
            geometry.push(value);
        }
    }
    if selected.is_none() {
        let ids: BTreeSet<_> = metadata
            .iter()
            .map(|m| m["element"].as_u64().unwrap())
            .collect();
        geometry.retain(|g| ids.contains(&g["element"].as_u64().unwrap()));
    }
    if selected.is_some()
        && (metadata.is_empty()
            || metadata.iter().any(|m| m["standalone"] != true)
            || geometry.is_empty())
    {
        return Err("missing/ambiguous standalone metadata or persisted geometry".into());
    }
    let report = json!({"schemaVersion":1,"sourceSha256":source,"element":selected,"metadata":metadata,"geometryRecords":geometry,"scope":"raw-source-records-not-yet-solid"});
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[2])?;
    out.write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    println!(
        "{}",
        json!({"element":selected,"metadata":report["metadata"].as_array().unwrap().len(),"records":report["geometryRecords"].as_array().unwrap().len()})
    );
    Ok(())
}
