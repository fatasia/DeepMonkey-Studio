//! Read-only research: raw candidate references, never wall geometry.
use rvt::{RevitFile, compression};
use serde_json::json;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let mut rf = RevitFile::open_bytes(std::fs::read(&args[0])?)?;
    assert!([2023, 2024].contains(&rf.basic_file_info()?.version));
    let id = args
        .get(1)
        .map(|s| s.parse::<u32>().unwrap())
        .unwrap_or(8570);
    let extent = args
        .get(2)
        .map(|v| v.parse::<usize>().unwrap())
        .unwrap_or(512)
        .min(8192);
    for path in rf
        .stream_names()
        .into_iter()
        .filter(|s| s.starts_with("Partitions/") || s == "Global/Latest")
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
        for (offset, w) in bytes.windows(4).enumerate() {
            if w != id.to_le_bytes() {
                continue;
            }
            // Optional framing filter avoids treating every reference slot as
            // a parent record while researching container placement.
            if args.get(3).is_some_and(|v| v == "framed") {
                let Some(header) = bytes.get(offset..offset + 16) else {
                    continue;
                };
                if header[4..8] != [0; 4] {
                    continue;
                }
                let length = u32::from_le_bytes(header[12..16].try_into()?) as usize;
                if length > 1024 * 1024 {
                    continue;
                }
                let Some(end) = bytes.get(offset + 16 + length..offset + 20 + length) else {
                    continue;
                };
                if end != &header[12..16] {
                    continue;
                }
            }
            let start = offset.saturating_sub(64);
            let framed = args.get(3).is_some_and(|v| v == "framed");
            let end = if framed {
                offset
                    + 20
                    + u32::from_le_bytes(bytes[offset + 12..offset + 16].try_into()?) as usize
            } else {
                (offset + extent).min(bytes.len())
            };
            let floats: Vec<_> = (start..end.saturating_sub(7))
                .filter_map(|i| {
                    if framed {
                        return None;
                    }
                    let v = f64::from_le_bytes(bytes[i..i + 8].try_into().unwrap());
                    (v.is_finite() && v.abs() > 0.01 && v.abs() < 1000.)
                        .then_some(json!([i as i64 - offset as i64, v]))
                })
                .collect();
            println!(
                "{}",
                json!({"stream":path,"offset":offset,"start":start,"hex":bytes[start..end].iter().map(|b|format!("{b:02x}")).collect::<String>(),"floatCandidates":floats})
            );
        }
    }
    Ok(())
}
