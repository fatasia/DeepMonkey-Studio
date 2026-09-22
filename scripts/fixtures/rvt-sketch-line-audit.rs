//! Persisted 2024 line payload audit. Exports source curves, not building solids.
#[path = "rvt-sketch-line.rs"]
mod line;
use rvt::{RevitFile, compression, partition_element_records as records};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("input.rvt new-output.json".into());
    }
    let bytes = std::fs::read(&args[0])?;
    if bytes.len() > 256 * 1024 * 1024 {
        return Err("input budget".into());
    }
    let source = sha(&bytes);
    let mut rf = RevitFile::open_bytes(bytes)?;
    if rf.basic_file_info()?.version != 2024 {
        return Err("unsupported version".into());
    }
    let declared: BTreeSet<_> = rvt::elem_table::parse_records(&mut rf)?
        .iter()
        .map(|r| r.id_primary)
        .collect();
    let mut lines: BTreeMap<u32, Vec<Value>> = BTreeMap::new();
    let mut metadata = BTreeMap::<u32, BTreeSet<u32>>::new();
    let mut streams = Vec::new();
    for path in rf
        .stream_names()
        .into_iter()
        .filter(|s| s.starts_with("Partitions/"))
    {
        let raw = rf.read_stream(&path)?;
        let prepared = compression::prepare_stream_for_inflate(&path, &raw);
        let mut bytes = Vec::new();
        for offset in compression::find_gzip_offsets(&prepared) {
            let chunk = compression::inflate_at_with_limits(
                &prepared,
                offset,
                compression::InflateLimits {
                    max_output_bytes: 256 * 1024 * 1024 - bytes.len(),
                },
            )?;
            bytes.extend(chunk);
        }
        if bytes.is_empty() {
            return Err("empty partition".into());
        }
        let records =
            records::find_category_records(&path, &bytes, records::OST_SKETCH_LINES, &declared);
        let mut candidates = BTreeMap::<u32, Vec<_>>::new();
        for record in records {
            if let Some(owner) = record.owner_reference {
                metadata
                    .entry(record.element_id)
                    .or_default()
                    .insert(owner as u32);
                candidates
                    .entry(record.element_id)
                    .or_default()
                    .push(record);
            }
        }
        for at in 0..bytes.len().saturating_sub(220) {
            let id = u64::from_le_bytes(bytes[at..at + 8].try_into()?);
            if id > u64::from(u32::MAX) {
                continue;
            }
            let Some(records) = candidates.get(&(id as u32)) else {
                continue;
            };
            for record in records {
                let size = u32::from_le_bytes(bytes[at + 12..at + 16].try_into()?) as usize;
                let Some(reference_at) = at
                    .checked_add(16)
                    .and_then(|n| n.checked_add(size))
                    .and_then(|n| n.checked_sub(92))
                else {
                    continue;
                };
                let Some(reference_bytes) = bytes.get(reference_at..reference_at + 8) else {
                    continue;
                };
                let reference = u64::from_le_bytes(reference_bytes.try_into()?);
                if !record.references.contains(&reference) {
                    continue;
                }
                if let Some(l) = line::decode(&bytes, at, record.element_id, reference) {
                    let points = l.endpoints();
                    let bounds_delta = (0..3)
                        .flat_map(|axis| {
                            [
                                (points[0][axis].min(points[1][axis]) - record.bbox_feet[axis])
                                    .abs(),
                                (points[0][axis].max(points[1][axis]) - record.bbox_feet[axis + 3])
                                    .abs(),
                            ]
                        })
                        .fold(0.0_f64, f64::max);
                    lines.entry(l.element).or_default().push(json!({"stream":path,"offset":at,"recordBytes":l.size,
                        "recordSha256":sha(&bytes[at..at+l.size]),"metadataOffset":record.offset,"sourceReferenceRaw":l.source_reference,
                        "owner":record.owner_reference,"range":l.range,"originFeet":l.origin,"direction":l.direction,"endpointsFeet":points,
                        "metadataBoundsDeltaFeet":bounds_delta}));
                }
            }
        }
        streams.push(json!({"stream":path,"inflatedBytes":bytes.len(),"sha256":sha(&bytes)}));
    }
    let mut resolved = Vec::new();
    let mut rejected = Vec::new();
    for (id, owners) in &metadata {
        let witnesses = lines.remove(id).unwrap_or_default();
        if witnesses.is_empty() {
            rejected.push(json!({"element":id,"owners":owners,"reason":"line-payload-missing-or-unsupported"}));
            continue;
        }
        let signature = |v: &Value| {
            json!([
                v["owner"],
                v["sourceReferenceRaw"],
                v["range"],
                v["originFeet"],
                v["direction"]
            ])
        };
        if owners.len() != 1
            || witnesses
                .iter()
                .any(|w| signature(w) != signature(&witnesses[0]))
        {
            rejected.push(json!({"element":id,"owners":owners,"reason":"conflicting-source-records","witnesses":witnesses}));
            continue;
        }
        resolved.push(json!({"element":id,"identity":format!("rvt:{source}:element:{id}"),"owner":owners.first(),
            "endpointsFeet":witnesses[0]["endpointsFeet"],"witnesses":witnesses}));
    }
    let report = json!({"schemaVersion":1,"quality":"source-curve-preview","buildingSolidGeometry":"missing","sourceSha256":source,
        "profile":"rvt-2024-persisted-sketch-line","unit":"feet","streams":streams,"lines":resolved,"rejected":rejected});
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[1])?;
    out.write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    println!(
        "{}",
        json!({"sourceLines":report["lines"].as_array().unwrap().len(),"rejected":report["rejected"].as_array().unwrap().len(),"output":args[1]})
    );
    Ok(())
}
