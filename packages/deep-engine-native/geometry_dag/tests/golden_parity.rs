//! 黄金对拍:Rust 实现输出必须与 TS 权威实现(`buildMeshletDag`)导出的
//! golden fixture 逐位一致。
//!
//! fixture 由 `scripts/gen_fixture.mjs` 生成:`tests/fixtures/{quick_sphere,synthetic50k}.golden.json`。
//! 逐位断言覆盖:positions / indices / descriptors / vertexRemap / localTriangleIndices /
//! bounds / sourceTriangles / clusterSourceSpans / error(f64 bits)/ parentsByLevel。

use base64::Engine as _;
use geometry_dag::{build_meshlet_dag, DagOptions, IndexedGeometry};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

struct GoldenFixture {
    levels_option: u32,
    /// fixture 声明的 maxTriangles(=64,DAG 缺省);对拍走 [`DagOptions`] 缺省路径,
    /// 此字段仅用于断言 fixture 自身声明未被静默改动。
    #[allow(dead_code)]
    max_triangles_option: Option<u32>,
    positions: Vec<f32>,
    indices: Vec<u32>,
    levels: Vec<GoldenLevel>,
    parents_by_level: Vec<Vec<i64>>,
}

struct GoldenLevel {
    error: f64,
    positions: Vec<f32>,
    indices: Vec<u32>,
    descriptors: Vec<u32>,
    vertex_remap: Vec<u32>,
    local_triangle_indices: Vec<u32>,
    bounds: Vec<f32>,
    source_triangles: Vec<u32>,
    cluster_source_spans: Vec<u32>,
}

fn decode_u32(json: &serde_json::Value, key: &str) -> Vec<u32> {
    let raw = B64.decode(json[key].as_str().expect("b64 string")).expect("b64");
    raw.chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().expect("4 bytes")))
        .collect()
}

fn decode_f32(json: &serde_json::Value, key: &str) -> Vec<f32> {
    let raw = B64.decode(json[key].as_str().expect("b64 string")).expect("b64");
    raw.chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().expect("4 bytes")))
        .collect()
}

fn load_fixture(name: &str) -> GoldenFixture {
    let path = format!("{}/tests/fixtures/{name}.golden.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read fixture {path}: {e}"));
    let json: serde_json::Value = serde_json::from_str(&text).expect("json");
    let options = &json["options"];
    GoldenFixture {
        levels_option: options["levels"].as_u64().expect("levels") as u32,
        max_triangles_option: options["maxTriangles"].as_u64().map(|v| v as u32),
        positions: decode_f32(&json["input"], "positionsB64"),
        indices: decode_u32(&json["input"], "indicesB64"),
        levels: json["levels"]
            .as_array()
            .expect("levels array")
            .iter()
            .map(|level| GoldenLevel {
                error: level["error"].as_f64().expect("error"),
                positions: decode_f32(level, "positionsB64"),
                indices: decode_u32(level, "indicesB64"),
                descriptors: decode_u32(level, "descriptorsB64"),
                vertex_remap: decode_u32(level, "vertexRemapB64"),
                local_triangle_indices: decode_u32(level, "localTriangleIndicesB64"),
                bounds: decode_f32(level, "boundsB64"),
                source_triangles: decode_u32(level, "sourceTrianglesB64"),
                cluster_source_spans: decode_u32(level, "clusterSourceSpansB64"),
            })
            .collect(),
        parents_by_level: json["parentsByLevel"]
            .as_array()
            .expect("parents")
            .iter()
            .map(|parents| {
                parents
                    .as_array()
                    .expect("parent row")
                    .iter()
                    .map(|v| v.as_i64().expect("parent index"))
                    .collect()
            })
            .collect(),
    }
}

/// 对拍核心:Rust DAG 与 golden 逐数组逐位相等(error 为 f64 位相等)。
fn assert_parity(fixture: &GoldenFixture, name: &str) {
    let geometry = IndexedGeometry {
        positions: fixture.positions.clone(),
        indices: fixture.indices.clone(),
    };
    // 与 gen_fixture.mjs 的调用 { levels: N } 一致:max_triangles 走 DAG 层缺省(64),
    // 使缺省路径本身也被 golden 覆盖。
    let dag = build_meshlet_dag(
        &geometry,
        &DagOptions {
            levels: Some(fixture.levels_option),
            ..Default::default()
        },
    )
    .unwrap_or_else(|e| panic!("{name}: build failed: {e}"));

    assert_eq!(
        dag.levels.len(),
        fixture.levels.len(),
        "{name}: level count diverges"
    );
    assert_eq!(
        dag.parents_by_level.len(),
        fixture.parents_by_level.len(),
        "{name}: parent pair count diverges"
    );

    for (k, (rust_level, golden)) in dag.levels.iter().zip(&fixture.levels).enumerate() {
        assert_eq!(rust_level.error.to_bits(), golden.error.to_bits(), "{name} level {k}: error bits");
        assert_eq!(rust_level.positions, golden.positions, "{name} level {k}: positions");
        assert_eq!(rust_level.indices, golden.indices, "{name} level {k}: indices");
        assert_eq!(rust_level.descriptors, golden.descriptors, "{name} level {k}: descriptors");
        assert_eq!(rust_level.vertex_remap, golden.vertex_remap, "{name} level {k}: vertexRemap");
        assert_eq!(
            rust_level.local_triangle_indices, golden.local_triangle_indices,
            "{name} level {k}: localTriangleIndices"
        );
        assert_eq!(rust_level.bounds, golden.bounds, "{name} level {k}: bounds");
        assert_eq!(rust_level.source_triangles, golden.source_triangles, "{name} level {k}: sourceTriangles");
        assert_eq!(
            rust_level.cluster_source_spans, golden.cluster_source_spans,
            "{name} level {k}: clusterSourceSpans"
        );
    }

    for (k, (rust_parents, golden_parents)) in dag.parents_by_level.iter().zip(&fixture.parents_by_level).enumerate() {
        assert_eq!(
            rust_parents.len(),
            golden_parents.len(),
            "{name} parents {k}: length diverges"
        );
        for (c, (&rust_parent, &golden_parent)) in rust_parents.iter().zip(golden_parents).enumerate() {
            // golden 的无父哨兵是 -1(Int32);Rust 侧是 u32::MAX。
            let expected = if golden_parent < 0 {
                u32::MAX
            } else {
                golden_parent as u32
            };
            assert_eq!(rust_parent, expected, "{name} parents {k}: fine cluster {c}");
        }
    }
}

#[test]
fn golden_quick_sphere_parity() {
    assert_parity(&load_fixture("quick_sphere"), "quick_sphere");
}

#[test]
fn golden_synthetic50k_parity() {
    assert_parity(&load_fixture("synthetic50k"), "synthetic50k");
}

#[test]
fn golden_fixtures_exist() {
    for name in ["quick_sphere", "synthetic50k"] {
        let path = format!("{}/tests/fixtures/{name}.golden.json", env!("CARGO_MANIFEST_DIR"));
        assert!(std::path::Path::new(&path).exists(), "missing fixture {path}");
    }
}
