//! Runtime payload appended to the Windows executable; no sidecar files.
use std::io::{Read, Seek, SeekFrom};

const MAGIC: &[u8; 8] = b"DMDASH01";
const FOOTER_BYTES: u64 = 48;
const MAX_PAYLOAD_BYTES: u64 = 256 * 1024 * 1024;
const NOTICES_MAGIC: &[u8; 8] = b"DMLICS01";
const MAX_NOTICES_BYTES: u64 = 8 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddedNotices {
    schema: String,
    schema_version: u32,
    pub license: String,
    pub third_party_notices: String,
}

pub fn read_notices(source: &mut (impl Read + Seek)) -> Result<EmbeddedNotices, String> {
    let payload = read(source)?.ok_or("overlay/no-embedded-package")?;
    let size = source
        .seek(SeekFrom::End(0))
        .map_err(|e| format!("overlay/size: {e}"))?;
    let start = size - FOOTER_BYTES - payload.len() as u64;
    if start < 16 {
        return Err("overlay/notices-missing".into());
    }
    source
        .seek(SeekFrom::Start(start - 16))
        .map_err(|e| format!("overlay/notices-seek: {e}"))?;
    let mut footer = [0; 16];
    source
        .read_exact(&mut footer)
        .map_err(|e| format!("overlay/notices-footer: {e}"))?;
    if &footer[8..] != NOTICES_MAGIC {
        return Err("overlay/notices-missing".into());
    }
    let length = u64::from_le_bytes(footer[..8].try_into().expect("fixed notices footer"));
    if length == 0 || length > MAX_NOTICES_BYTES || length > start - 16 {
        return Err("overlay/notices-length".into());
    }
    source
        .seek(SeekFrom::Start(start - 16 - length))
        .map_err(|e| format!("overlay/notices-seek: {e}"))?;
    let mut bytes = vec![0; length as usize];
    source
        .read_exact(&mut bytes)
        .map_err(|e| format!("overlay/notices-read: {e}"))?;
    let notices: EmbeddedNotices =
        serde_json::from_slice(&bytes).map_err(|e| format!("overlay/notices-json: {e}"))?;
    if notices.schema != "deep-engine.embedded-notices"
        || notices.schema_version != 1
        || notices.license.trim().is_empty()
        || notices.third_party_notices.trim().is_empty()
    {
        return Err("overlay/notices-schema".into());
    }
    Ok(notices)
}

pub fn read(source: &mut (impl Read + Seek)) -> Result<Option<Vec<u8>>, String> {
    let size = source
        .seek(SeekFrom::End(0))
        .map_err(|e| format!("overlay/size: {e}"))?;
    let tail_size = size.min(FOOTER_BYTES);
    source
        .seek(SeekFrom::End(-(tail_size as i64)))
        .map_err(|e| format!("overlay/seek: {e}"))?;
    let mut footer = vec![0; tail_size as usize];
    source
        .read_exact(&mut footer)
        .map_err(|e| format!("overlay/footer: {e}"))?;
    if footer.get(..8) != Some(MAGIC.as_slice()) {
        if footer.windows(MAGIC.len()).any(|window| window == MAGIC) {
            return Err("overlay/truncated-footer".into());
        }
        return Ok(None);
    }
    if tail_size != FOOTER_BYTES {
        return Err("overlay/truncated-footer".into());
    }
    let length = u64::from_le_bytes(footer[8..16].try_into().expect("fixed footer length"));
    if length == 0 || length > MAX_PAYLOAD_BYTES || length > size - FOOTER_BYTES {
        return Err("overlay/payload-length".into());
    }
    source
        .seek(SeekFrom::Start(size - FOOTER_BYTES - length))
        .map_err(|e| format!("overlay/payload-seek: {e}"))?;
    let mut payload = vec![0; length as usize];
    source
        .read_exact(&mut payload)
        .map_err(|e| format!("overlay/payload-read: {e}"))?;
    let expected = footer[16..]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if crate::shader_package::hash::sha256(&payload) != expected {
        return Err("overlay/payload-hash".into());
    }
    Ok(Some(payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn embedded(payload: &[u8]) -> Vec<u8> {
        let mut bytes = b"MZ-test-executable".to_vec();
        bytes.extend_from_slice(payload);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        let hash = crate::shader_package::hash::sha256(payload);
        bytes.extend(
            (0..hash.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hash[i..i + 2], 16).unwrap()),
        );
        bytes
    }

    #[test]
    fn recovers_exact_bytes_without_a_sidecar() {
        let payload = include_bytes!("../../deep-engine/fixtures/dashboard-composition-v1.json");
        let result = read(&mut Cursor::new(embedded(payload))).unwrap().unwrap();
        assert_eq!(result, payload);
        crate::runtime_package::parse_and_validate_runtime_package(&result).unwrap();
    }

    #[test]
    fn plain_executables_keep_the_existing_startup_path() {
        for bytes in [vec![], b"MZ".to_vec(), vec![1; 1024]] {
            assert_eq!(read(&mut Cursor::new(bytes)).unwrap(), None);
        }
    }

    #[test]
    fn refuses_tampered_payload_hash_and_lengths_before_allocating() {
        let baseline = embedded(b"payload");
        let mut corrupt = baseline.clone();
        corrupt[18] ^= 1;
        assert!(
            read(&mut Cursor::new(corrupt))
                .unwrap_err()
                .contains("hash")
        );
        for length in [0, MAX_PAYLOAD_BYTES + 1, u64::MAX, 1000] {
            let mut corrupt = baseline.clone();
            let start = corrupt.len() - 40;
            corrupt[start..start + 8].copy_from_slice(&length.to_le_bytes());
            assert!(
                read(&mut Cursor::new(corrupt))
                    .unwrap_err()
                    .contains("length")
            );
        }
    }

    #[test]
    fn truncated_marker_never_falls_back_to_demo_content() {
        for retained in [8, 16, 32, 47] {
            let bytes = embedded(b"payload");
            let size = bytes.len() - 48 + retained;
            assert!(read(&mut Cursor::new(bytes[..size].to_vec())).is_err());
        }
    }

    fn with_notices(value: serde_json::Value) -> Vec<u8> {
        let notes = serde_json::to_vec(&value).unwrap();
        let mut bytes = b"MZ-test".to_vec();
        bytes.extend_from_slice(&notes);
        bytes.extend_from_slice(&(notes.len() as u64).to_le_bytes());
        bytes.extend_from_slice(NOTICES_MAGIC);
        bytes.extend_from_slice(&embedded(b"payload")[b"MZ-test-executable".len()..]);
        bytes
    }

    #[test]
    fn embedded_licenses_are_read_without_extracting_files() {
        let bytes = with_notices(
            serde_json::json!({ "schema": "deep-engine.embedded-notices", "schemaVersion": 1,
            "license": "许可原文", "thirdPartyNotices": "Third-party notices" }),
        );
        let notices = read_notices(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(notices.license, "许可原文");
        assert_eq!(notices.third_party_notices, "Third-party notices");
        assert!(
            read_notices(&mut Cursor::new(embedded(b"payload")))
                .err()
                .unwrap()
                .contains("missing")
        );
    }

    #[test]
    fn rejects_invalid_license_schema_and_length() {
        let value = serde_json::json!({ "schema": "wrong", "schemaVersion": 1, "license": "L", "thirdPartyNotices": "T" });
        let bytes = with_notices(value);
        assert!(
            read_notices(&mut Cursor::new(bytes.clone()))
                .err()
                .unwrap()
                .contains("schema")
        );
        let mut corrupt = bytes;
        let start = corrupt.len() - 48 - b"payload".len() - 16;
        corrupt[start..start + 8].copy_from_slice(&(MAX_NOTICES_BYTES + 1).to_le_bytes());
        assert!(
            read_notices(&mut Cursor::new(corrupt))
                .err()
                .unwrap()
                .contains("length")
        );
    }
}
