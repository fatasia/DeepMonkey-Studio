//! Persist source model-group headers and framed group carriers, not placements.
use rvt::{RevitFile, compression};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, io::Write};
fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<_> = std::env::args().skip(1).collect();
    if a.len() != 2 {
        return Err("source.rvt new-output.json".into());
    }
    let input = std::fs::read(&a[0])?;
    let source = sha(&input);
    let mut rf = RevitFile::open_bytes(input)?;
    if rf.basic_file_info()?.version != 2024 {
        return Err("unsupported version".into());
    }
    let declared: BTreeSet<_> = rvt::elem_table::parse_records(&mut rf)?
        .iter()
        .map(|r| r.id_primary)
        .collect();
    let mut headers = Vec::new();
    let mut carriers = Vec::new();
    let mut groups = BTreeSet::new();
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
        for (at, w) in bytes.windows(8).enumerate() {
            let id = u64::from_le_bytes(w.try_into()?);
            if id > u32::MAX as u64 || !declared.contains(&(id as u32)) {
                continue;
            }
            let Some(head) = bytes.get(at..at + 26) else {
                continue;
            };
            if head[12..16] == 1439u32.to_le_bytes() && head[18..26] == (-2000095i64).to_le_bytes()
            {
                groups.insert(id);
                let end = (at + 1200).min(bytes.len());
                headers.push(json!({"element":id,"stream":path,"offset":at,"hex":bytes[at..end].iter().map(|b|format!("{b:02x}")).collect::<String>()}));
            }
            if head[16..20] != [0x98, 5, 0, 0] && !groups.contains(&id) {
                continue;
            }
            let size = u32::from_le_bytes(head[12..16].try_into()?) as usize;
            if size < 16 || size > 1024 * 1024 {
                continue;
            }
            let Some(record) = bytes.get(at..at + 20 + size) else {
                continue;
            };
            if record[record.len() - 4..] != head[12..16] {
                continue;
            }
            carriers.push(json!({"element":id,"stream":path,"offset":at,"sha256":sha(record),"hex":record.iter().map(|b|format!("{b:02x}")).collect::<String>()}));
        }
    }
    let report = json!({"sourceSha256":source,"headers":headers,"carriers":carriers,"scope":"raw-source-group-carriers-not-placement-proof"});
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&a[1])?;
    file.write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    println!(
        "{}",
        json!({"headers":report["headers"].as_array().unwrap().len(),"carriers":report["carriers"].as_array().unwrap().len()})
    );
    Ok(())
}
