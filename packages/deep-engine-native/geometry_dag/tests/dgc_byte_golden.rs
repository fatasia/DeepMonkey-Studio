//! `.dgc` 序列化字节黄金钉版(frame-v8 / sdf-gi-native-parity 同法:字节入库,门常开)。
//!
//! 背景:跨工具链对拍(TS `decodeDgc` 读 Rust CLI 产物)以 sha256 钉版
//! (`packages/deep-engine/src/geometry/dgcLoader.test.ts`),但工件不入库
//! (`test-output/` 本地生成),干净环境下该门 skip。本文件把**字节合同**补成
//! always-on:quick_sphere(528 tri,2 层)的 `.dgc` 两种压缩档字节入库
//! `tests/fixtures/quick_sphere.dgc.golden.json`,任何环境断言——
//! 1. `write_dgc`(压缩/未压缩)逐字节 == 入库字节(序列化漂移立即打红);
//! 2. `read_dgc`(入库字节)重建 DAG == golden 重建(解码回路);
//! 3. fixture 自身 sha256/byteCount 声明自洽(防 fixture 被静默改动)。
//!
//! 压缩档字节锁定依赖 Cargo.lock 钉版的 flate2(rust_backend/miniz_oxide)确定性输出;
//! 未压缩档与 zlib 实现无关,永久锁定容器布局。若未来升级压缩库导致压缩流漂移,
//! `write_compressed_bit_exact` 会明确指向压缩层,而未压缩门仍然守恒——分层归因。
//!
//! 重新生成:`cargo test --test dgc_byte_golden -- --ignored regenerate_fixture --nocapture`
//! (填充器幂等:连续两次产出逐字节一致,由 `regenerate_fixture_is_idempotent` 钉住)。

mod common;

use base64::Engine as _;
use common::{B64, load_fixture, sha256_hex};
use geometry_dag::{DagOptions, DgcWriteOptions, build_meshlet_dag, write_dgc};
use std::collections::BTreeMap;
use std::fmt::Write as _;

const FIXTURE_NAME: &str = "quick_sphere";
const FIXTURE_PATH: &str = "tests/fixtures/quick_sphere.dgc.golden.json";

struct ByteVariant {
    sha256: String,
    byte_count: usize,
    bytes_b64: String,
}

fn golden_dag() -> geometry_dag::MeshletDag {
    let fixture = load_fixture(FIXTURE_NAME);
    let geometry = geometry_dag::IndexedGeometry {
        positions: fixture.positions,
        indices: fixture.indices,
    };
    build_meshlet_dag(
        &geometry,
        &DagOptions {
            levels: Some(fixture.levels_option),
            ..Default::default()
        },
    )
    .expect("build golden dag")
}

/// 由生产写入路径生成两个压缩档的字节变体(排序键固定,JSON 字段稳定)。
fn compute_variants() -> BTreeMap<String, ByteVariant> {
    let dag = golden_dag();
    let mut variants = BTreeMap::new();
    for (name, options) in [
        ("compressed", DgcWriteOptions { compress: true }),
        ("uncompressed", DgcWriteOptions { compress: false }),
    ] {
        let bytes = write_dgc(&dag, &options).expect("write dgc");
        variants.insert(
            name.to_string(),
            ByteVariant {
                sha256: sha256_hex(&bytes),
                byte_count: bytes.len(),
                bytes_b64: B64.encode(&bytes),
            },
        );
    }
    variants
}

fn fixture_json(variants: &BTreeMap<String, ByteVariant>) -> String {
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(
        "  \"source\": \"write_dgc(build_meshlet_dag(quick_sphere.golden.json input, levels=fixture)) — TS 权威 DAG 的 Rust 序列化字节\",\n",
    );
    out.push_str(
        "  \"format\": \"packages/deep-engine-native/geometry_dag/docs/dgc-format-spec.md v1\",\n",
    );
    out.push_str(
        "  \"authority\": \"packages/deep-engine/src/geometry/meshletDag.ts buildMeshletDag(golden 见 quick_sphere.golden.json,双端已逐位对拍)\",\n",
    );
    out.push_str(
        "  \"regenerate\": \"cd packages/deep-engine-native/geometry_dag && cargo test --test dgc_byte_golden -- --ignored regenerate_fixture --nocapture\",\n",
    );
    out.push_str("  \"variants\": {\n");
    let last = variants.len() - 1;
    for (index, (name, variant)) in variants.iter().enumerate() {
        let _ = writeln!(
            out,
            "    \"{}\": {{\n      \"sha256\": \"{}\",\n      \"byteCount\": {},\n      \"bytesB64\": \"{}\"\n    }}{}",
            name,
            variant.sha256,
            variant.byte_count,
            variant.bytes_b64,
            if index == last { "\n" } else { ",\n" }
        );
    }
    out.push_str("  }\n}\n");
    out
}

/// `#[ignore]` 填充器:重新生成字节黄金 fixture(沿 frame-v8 filler 先例)。
#[test]
#[ignore = "fixture filler: run with --ignored to (re)generate the committed byte golden"]
fn regenerate_fixture() {
    let json = fixture_json(&compute_variants());
    let path = format!("{}/{FIXTURE_PATH}", env!("CARGO_MANIFEST_DIR"));
    std::fs::write(&path, &json).unwrap_or_else(|e| panic!("write fixture {path}: {e}"));
    for (name, variant) in compute_variants() {
        println!(
            "{name}: sha256={} bytes={}",
            variant.sha256, variant.byte_count
        );
    }
    println!("fixture written: {path}");
}

/// 幂等守卫:填充器逻辑连续两次产出逐字节一致(frame-v8 教训:filler 必须幂等)。
#[test]
fn regenerate_fixture_is_idempotent() {
    let first = fixture_json(&compute_variants());
    let second = fixture_json(&compute_variants());
    assert_eq!(first, second, "filler output must be deterministic");
}

fn load_byte_fixture() -> BTreeMap<String, ByteVariant> {
    let path = format!("{}/{FIXTURE_PATH}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let json: serde_json::Value = serde_json::from_str(&text).expect("fixture json");
    let mut variants = BTreeMap::new();
    for (name, entry) in json["variants"].as_object().expect("variants object") {
        variants.insert(
            name.clone(),
            ByteVariant {
                sha256: entry["sha256"].as_str().expect("sha256").to_string(),
                byte_count: entry["byteCount"].as_u64().expect("byteCount") as usize,
                bytes_b64: entry["bytesB64"].as_str().expect("bytesB64").to_string(),
            },
        );
    }
    assert_eq!(
        variants.len(),
        2,
        "fixture must carry both compression variants"
    );
    variants
}

fn decode_variant(variant: &ByteVariant) -> Vec<u8> {
    let bytes = B64
        .decode(variant.bytes_b64.as_bytes())
        .expect("fixture b64");
    assert_eq!(
        bytes.len(),
        variant.byte_count,
        "byteCount declaration drift"
    );
    assert_eq!(
        sha256_hex(&bytes),
        variant.sha256,
        "sha256 declaration drift"
    );
    bytes
}

#[test]
fn fixture_variants_self_consistent() {
    for (name, variant) in load_byte_fixture() {
        let bytes = decode_variant(&variant);
        assert_eq!(&bytes[0..4], b"DGC1", "{name}: magic");
        let flags = u32::from_le_bytes(bytes[8..12].try_into().expect("4 bytes"));
        let expected_flag = u32::from(name == "compressed") * geometry_dag::FLAG_ZLIB;
        assert_eq!(
            flags, expected_flag,
            "{name}: FLAG_ZLIB must match variant name"
        );
    }
}

#[test]
fn write_compressed_bit_exact() {
    let dag = golden_dag();
    let bytes = write_dgc(&dag, &DgcWriteOptions { compress: true }).expect("write");
    let golden = decode_variant(&load_byte_fixture()["compressed"]);
    assert_eq!(
        bytes, golden,
        "compressed write_dgc bytes drift from committed golden"
    );
}

#[test]
fn write_uncompressed_bit_exact() {
    let dag = golden_dag();
    let bytes = write_dgc(&dag, &DgcWriteOptions { compress: false }).expect("write");
    let golden = decode_variant(&load_byte_fixture()["uncompressed"]);
    assert_eq!(
        bytes, golden,
        "uncompressed write_dgc bytes drift from committed golden"
    );
}

fn assert_roundtrip(bytes: &[u8], label: &str) {
    let dag = golden_dag();
    let back =
        geometry_dag::read_dgc(bytes).unwrap_or_else(|e| panic!("{label}: read failed: {e}"));
    assert_eq!(back.levels.len(), dag.levels.len(), "{label}: level count");
    for (index, (back_level, level)) in back.levels.iter().zip(&dag.levels).enumerate() {
        assert_eq!(
            back_level.error.to_bits(),
            level.error.to_bits(),
            "{label} level {index}: error bits"
        );
        assert_eq!(
            back_level.positions, level.positions,
            "{label} level {index}: positions"
        );
        assert_eq!(
            back_level.indices, level.indices,
            "{label} level {index}: indices"
        );
        assert_eq!(
            back_level.descriptors, level.descriptors,
            "{label} level {index}: descriptors"
        );
        assert_eq!(
            back_level.vertex_remap, level.vertex_remap,
            "{label} level {index}: vertexRemap"
        );
        assert_eq!(
            back_level.local_triangle_indices, level.local_triangle_indices,
            "{label} level {index}: localTriangleIndices"
        );
        assert_eq!(
            back_level.bounds, level.bounds,
            "{label} level {index}: bounds"
        );
        assert_eq!(
            back_level.source_triangles, level.source_triangles,
            "{label} level {index}: sourceTriangles"
        );
        assert_eq!(
            back_level.cluster_source_spans, level.cluster_source_spans,
            "{label} level {index}: clusterSourceSpans"
        );
    }
    assert_eq!(
        back.parents_by_level, dag.parents_by_level,
        "{label}: parents"
    );
}

#[test]
fn read_roundtrip_from_committed_bytes() {
    for (name, variant) in load_byte_fixture() {
        assert_roundtrip(&decode_variant(&variant), &name);
    }
}
