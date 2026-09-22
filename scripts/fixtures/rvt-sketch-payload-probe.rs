//! Raw sketch payload research, not bbox-derived curve export.
use rvt::{RevitFile, compression, partition_element_records as records};
use serde_json::json;
use std::collections::BTreeSet;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = std::env::args().nth(1).unwrap();
    let mut rf = RevitFile::open_bytes(std::fs::read(source)?)?;
    assert_eq!(rf.basic_file_info()?.version, 2024);
    let declared: BTreeSet<_> = rvt::elem_table::parse_records(&mut rf)?
        .iter()
        .map(|r| r.id_primary)
        .collect();
    for path in rf
        .stream_names()
        .into_iter()
        .filter(|s| s.starts_with("Partitions/"))
    {
        let raw = rf.read_stream(&path)?;
        let prepared = compression::prepare_stream_for_inflate(&path, &raw);
        let mut bytes = Vec::new();
        for offset in compression::find_gzip_offsets(&prepared) {
            if let Ok(chunk) = compression::inflate_at_with_limits(
                &prepared,
                offset,
                compression::InflateLimits {
                    max_output_bytes: 256 * 1024 * 1024 - bytes.len(),
                },
            ) {
                bytes.extend(chunk);
            }
        }
        for record in
            records::find_category_records(&path, &bytes, records::OST_SKETCH_LINES, &declared)
                .into_iter()
                .take(20)
        {
            let mut at = record.offset + 136;
            for _ in 0..2 {
                let refs = records::decode_reference_list(&bytes, at).ok_or("invalid refs")?;
                at += 4 + refs.len() * 8;
            }
            println!(
                "{}",
                json!({"stream":path,"offset":record.offset,"element":record.element_id,"owner":record.owner_reference,"bbox":record.bbox_feet,"payloadOffset":at,"hex":bytes[at..(at+1024).min(bytes.len())].iter().map(|b|format!("{b:02x}")).collect::<String>()})
            );
        }
    }
    Ok(())
}
