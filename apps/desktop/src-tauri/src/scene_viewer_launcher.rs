use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use tauri::http::{Response, StatusCode, header};
use tauri::{Runtime, UriSchemeContext};

const FOOTER_MAGIC: &[u8; 8] = b"DMTHREE1";
const FOOTER_BYTES: u64 = 48;
const MAX_PAYLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const VIEWER_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ipc:; worker-src 'self' blob:";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadHeader {
    schema: String,
    schema_version: u8,
    package_id: String,
    product_name: String,
    source_content_hash: String,
    files: Vec<PayloadFile>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadFile {
    path: String,
    offset: usize,
    bytes: usize,
    sha256: String,
    content_type: String,
}

#[derive(Clone, Debug)]
pub(crate) struct SceneViewerPayload {
    header: PayloadHeader,
    content: Arc<Vec<u8>>,
    content_offset: usize,
    files: HashMap<String, PayloadFile>,
    payload_sha256: String,
}

impl SceneViewerPayload {
    pub(crate) fn product_name(&self) -> &str {
        &self.header.product_name
    }

    fn file(&self, path: &str) -> Option<(&PayloadFile, &[u8])> {
        let descriptor = self.files.get(path)?;
        let start = self.content_offset.checked_add(descriptor.offset)?;
        let end = start.checked_add(descriptor.bytes)?;
        self.content
            .get(start..end)
            .map(|bytes| (descriptor, bytes))
    }
}

static EMBEDDED_PAYLOAD: OnceLock<Result<Option<Arc<SceneViewerPayload>>, String>> =
    OnceLock::new();

pub(crate) fn embedded_payload() -> Result<Option<Arc<SceneViewerPayload>>, String> {
    EMBEDDED_PAYLOAD
        .get_or_init(|| {
            let executable = std::env::current_exe()
                .map_err(|error| format!("无法定位 Three 启动器：{error}"))?;
            read_payload(&executable).map(|payload| payload.map(Arc::new))
        })
        .clone()
}

pub(crate) fn handle_inspection_cli() -> bool {
    if !std::env::args().any(|argument| argument == "--inspect-scene-viewer-payload") {
        return false;
    }
    match embedded_payload() {
        Ok(Some(payload)) => {
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Inspection<'a> {
                ok: bool,
                schema_version: u8,
                package_id: &'a str,
                product_name: &'a str,
                source_content_hash: &'a str,
                payload_sha256: &'a str,
                file_count: usize,
                read_only: bool,
            }
            let inspection = Inspection {
                ok: true,
                schema_version: payload.header.schema_version,
                package_id: &payload.header.package_id,
                product_name: &payload.header.product_name,
                source_content_hash: &payload.header.source_content_hash,
                payload_sha256: &payload.payload_sha256,
                file_count: payload.header.files.len(),
                read_only: true,
            };
            println!(
                "{}",
                serde_json::to_string(&inspection).expect("serialize inspection")
            );
        }
        Ok(None) => {
            eprintln!("Three WebView 启动器未附加场景负载");
            std::process::exit(2);
        }
        Err(error) => {
            eprintln!("Three WebView 场景负载校验失败：{error}");
            std::process::exit(2);
        }
    }
    true
}

pub(crate) fn protocol_response<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let decoded = percent_decode_str(request.uri().path())
        .decode_utf8()
        .map(|value| value.trim_start_matches('/').to_owned());
    let Ok(mut path) = decoded else {
        return response(
            StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            b"invalid path".to_vec(),
        );
    };
    if path.is_empty() {
        path = "index.html".to_owned();
    }
    if !safe_path(&path) {
        return response(
            StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            b"invalid path".to_vec(),
        );
    }
    if let Ok(Some(payload)) = embedded_payload()
        && let Some((descriptor, bytes)) = payload.file(&path)
    {
        return response(StatusCode::OK, &descriptor.content_type, bytes.to_vec());
    }

    let resolver = context.app_handle().asset_resolver();
    let asset = resolver.get_for_scheme(path.clone(), false).or_else(|| {
        (!Path::new(&path).extension().is_some())
            .then(|| resolver.get_for_scheme("index.html".to_owned(), false))
            .flatten()
    });
    let Some(asset) = asset else {
        return response(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"not found".to_vec(),
        );
    };
    let mut bytes = asset.bytes;
    let content_type = asset.mime_type;
    if path == "index.html" || content_type.starts_with("text/html") {
        let Ok(html) = String::from_utf8(bytes) else {
            return response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain; charset=utf-8",
                b"invalid index".to_vec(),
            );
        };
        let marker =
            "<meta name=\"scene-viewer-delivery\" content=\"/delivery/scene-viewer.json\">";
        if !html.contains("</head>") {
            return response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain; charset=utf-8",
                b"invalid index".to_vec(),
            );
        }
        bytes = html
            .replace("</head>", &format!("  {marker}\n</head>"))
            .into_bytes();
    }
    response(StatusCode::OK, &content_type, bytes)
}

fn response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, VIEWER_CSP)
        .body(body)
        .expect("valid Three WebView protocol response")
}

fn read_payload(executable: &Path) -> Result<Option<SceneViewerPayload>, String> {
    let mut file = File::open(executable).map_err(|error| format!("打开启动器失败：{error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("读取启动器大小失败：{error}"))?
        .len();
    if length < FOOTER_BYTES {
        return Ok(None);
    }
    file.seek(SeekFrom::End(-(FOOTER_BYTES as i64)))
        .map_err(|error| format!("定位启动器尾部失败：{error}"))?;
    let mut footer = [0_u8; FOOTER_BYTES as usize];
    file.read_exact(&mut footer)
        .map_err(|error| format!("读取启动器尾部失败：{error}"))?;
    if &footer[..FOOTER_MAGIC.len()] != FOOTER_MAGIC {
        return Ok(None);
    }
    let payload_length = u64::from_le_bytes(footer[8..16].try_into().expect("fixed footer"));
    if payload_length < 4
        || payload_length > MAX_PAYLOAD_BYTES
        || payload_length + FOOTER_BYTES > length
    {
        return Err("Three WebView 场景负载长度无效".to_owned());
    }
    let payload_start = length - FOOTER_BYTES - payload_length;
    file.seek(SeekFrom::Start(payload_start))
        .map_err(|error| format!("定位 Three 场景负载失败：{error}"))?;
    let mut content = vec![0_u8; payload_length as usize];
    file.read_exact(&mut content)
        .map_err(|error| format!("读取 Three 场景负载失败：{error}"))?;
    let payload_digest = Sha256::digest(&content);
    if payload_digest.as_slice() != &footer[16..48] {
        return Err("Three WebView 场景负载哈希不匹配".to_owned());
    }
    parse_payload(content, format!("{payload_digest:x}"))
}

fn parse_payload(
    content: Vec<u8>,
    payload_sha256: String,
) -> Result<Option<SceneViewerPayload>, String> {
    if content.len() < 4 {
        return Err("Three WebView 场景负载头缺失".to_owned());
    }
    let header_length = u32::from_le_bytes(content[..4].try_into().expect("four bytes")) as usize;
    if header_length == 0 || header_length > MAX_HEADER_BYTES || 4 + header_length > content.len() {
        return Err("Three WebView 场景负载头长度无效".to_owned());
    }
    let header: PayloadHeader = serde_json::from_slice(&content[4..4 + header_length])
        .map_err(|error| format!("解析 Three 场景负载头失败：{error}"))?;
    if header.schema != "deep-monkey.three-scene-viewer-payload"
        || header.schema_version != 1
        || !short_id(&header.package_id)
        || !sha256_hex(&header.source_content_hash)
        || header.product_name.trim().is_empty()
        || header.product_name.chars().count() > 80
        || header.product_name.chars().any(char::is_control)
        || header.files.is_empty()
    {
        return Err("Three WebView 场景负载身份无效".to_owned());
    }
    let content_offset = 4 + header_length;
    let data_length = content.len() - content_offset;
    let mut files = HashMap::new();
    let mut paths = HashSet::new();
    let mut ranges = Vec::new();
    for descriptor in &header.files {
        let end = descriptor
            .offset
            .checked_add(descriptor.bytes)
            .filter(|end| *end <= data_length)
            .ok_or_else(|| format!("Three WebView 文件越界：{}", descriptor.path))?;
        if !safe_path(&descriptor.path)
            || !paths.insert(descriptor.path.to_ascii_lowercase())
            || !sha256_hex(&descriptor.sha256)
            || descriptor.content_type.trim().is_empty()
        {
            return Err("Three WebView 文件索引无效".to_owned());
        }
        let bytes = &content[content_offset + descriptor.offset..content_offset + end];
        if format!("{:x}", Sha256::digest(bytes)) != descriptor.sha256 {
            return Err(format!("Three WebView 文件哈希不匹配：{}", descriptor.path));
        }
        ranges.push((descriptor.offset, end));
        files.insert(descriptor.path.clone(), descriptor.clone());
    }
    ranges.sort_unstable();
    if ranges.first().map(|range| range.0) != Some(0)
        || ranges.last().map(|range| range.1) != Some(data_length)
        || ranges.windows(2).any(|pair| pair[0].1 != pair[1].0)
        || !files.contains_key("delivery/scene-viewer.json")
    {
        return Err("Three WebView 文件区不连续或缺少只读清单".to_owned());
    }
    Ok(Some(SceneViewerPayload {
        header,
        content: Arc::new(content),
        content_offset,
        files,
        payload_sha256,
    }))
}

fn safe_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.contains(':')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn short_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_payload(path: &str, body: &[u8]) -> Vec<u8> {
        let header = serde_json::json!({
            "schema": "deep-monkey.three-scene-viewer-payload",
            "schemaVersion": 1,
            "packageId": "1234567890abcdef",
            "productName": "Factory Viewer",
            "sourceContentHash": "a".repeat(64),
            "files": [{ "path": path, "offset": 0, "bytes": body.len(),
                "sha256": format!("{:x}", Sha256::digest(body)), "contentType": "application/json" }]
        });
        let header = serde_json::to_vec(&header).unwrap();
        let mut payload = (header.len() as u32).to_le_bytes().to_vec();
        payload.extend(header);
        payload.extend(body);
        payload
    }

    #[test]
    fn accepts_contiguous_verified_payload() {
        let payload = fixture_payload("delivery/scene-viewer.json", b"{}");
        let parsed = parse_payload(payload.clone(), format!("{:x}", Sha256::digest(&payload)))
            .unwrap()
            .unwrap();
        assert_eq!(parsed.product_name(), "Factory Viewer");
        assert_eq!(parsed.file("delivery/scene-viewer.json").unwrap().1, b"{}");
    }

    #[test]
    fn rejects_traversal_and_tampering() {
        assert!(parse_payload(fixture_payload("../scene.json", b"{}"), "a".repeat(64)).is_err());
        let mut payload = fixture_payload("delivery/scene-viewer.json", b"{}");
        *payload.last_mut().unwrap() ^= 1;
        assert!(parse_payload(payload, "a".repeat(64)).is_err());
    }
}
