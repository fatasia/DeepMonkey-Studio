//! `geometry_dag` — Deep Engine Nanite M2 离线编译工具链。
//!
//! 管线:索引化网格 → 贪心簇划分 → 层级聚类简化 DAG(父子单射)→ `.dgc` 流式格式。
//!
//! 与 TS 权威实现(`packages/deep-engine/src/geometry/` 的 `buildMeshlets` /
//! `buildMeshletDag`)逐位对拍,黄金样本回归见 `tests/golden_parity.rs`
//! (fixture 由 `scripts/gen_fixture.mjs` 从 TS 侧导出)。
//!
//! # 快速上手
//! ```no_run
//! use geometry_dag::{parse_obj, build_meshlet_dag, DagOptions, write_dgc, DgcWriteOptions};
//! let text = std::fs::read_to_string("mesh.obj").expect("read obj");
//! let geometry = parse_obj(&text).expect("parse obj");
//! let dag = build_meshlet_dag(&geometry, &DagOptions::default()).expect("build dag");
//! let bytes = write_dgc(&dag, &DgcWriteOptions::default()).expect("serialize");
//! std::fs::write("mesh.dgc", bytes).expect("write dgc");
//! ```

#![warn(missing_docs)]
#![warn(missing_debug_implementations)]

pub mod bounds;
pub mod dag;
pub mod dgc;
pub mod error;
pub mod local_triangle;
pub mod meshlet_builder;
pub mod obj;
pub mod simplify;
pub mod types;
pub mod validation;

pub use dag::{build_meshlet_dag, DagLevel, DagOptions, MeshletDag};
pub use dgc::{crc32c, read_dgc, write_dgc, DgcWriteOptions, FLAG_ZLIB, NO_PARENT};
pub use error::{DagError, DagResult};
pub use local_triangle::{pack_local_triangle, unpack_local_triangle};
pub use meshlet_builder::{build_meshlets, MeshletBuildResult};
pub use obj::{parse_obj, write_obj};
pub use simplify::{cluster_simplify, ClusterSimplifyResult};
pub use types::{
    IndexedGeometry, MESHLET_BOUNDS_STRIDE, MESHLET_DESCRIPTOR_STRIDE, MESHLET_SCHEMA_VERSION,
};
pub use validation::validate_input;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_pipeline_smoke() {
        let geometry = IndexedGeometry {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            indices: vec![0, 1, 2],
        };
        let dag = build_meshlet_dag(&geometry, &DagOptions::default()).expect("dag");
        assert_eq!(dag.levels[0].meshlet_count, 1);
        let bytes = write_dgc(&dag, &DgcWriteOptions::default()).expect("dgc");
        let back = read_dgc(&bytes).expect("parse dgc");
        assert_eq!(back.levels[0].indices, geometry.indices);
    }
}
