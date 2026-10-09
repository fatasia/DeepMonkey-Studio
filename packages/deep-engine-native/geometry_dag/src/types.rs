//! 核心常量与数据结构。
//!
//! 与 TS 权威实现(`packages/deep-engine/src/geometry/types.ts` + `meshletDag.ts`)
//! 字段一一对应;`docs/dgc-format-spec.md` 定义这些数组的持久化布局。

/// 簇描述符步长:`[vertexOffset, vertexCount, triangleOffset, triangleCount]`,
/// 每簇一条 16 字节记录,偏移是元素偏移而非字节偏移。
pub const MESHLET_DESCRIPTOR_STRIDE: usize = 4;

/// 包围盒步长:`sphere vec4, aabbMin vec4, aabbMax vec4, normalCone vec4`,
/// 每簇一条 64 字节记录。cone cutoff 为 -1 表示法向锥剔除禁用。
pub const MESHLET_BOUNDS_STRIDE: usize = 16;

/// 当前 schema 版本(与 TS `MESHLET_SCHEMA_VERSION` 同步)。
pub const MESHLET_SCHEMA_VERSION: u32 = 1;

/// 簇默认顶点上限(TS `MESHLET_DEFAULTS.maxVertices`)。
pub const MESHLET_MAX_VERTICES_LIMIT: u32 = 64;

/// 簇默认三角形上限(TS `MESHLET_DEFAULTS.maxTriangles`)。
pub const MESHLET_MAX_TRIANGLES_LIMIT: u32 = 126;

/// 构建预算:源顶点数上限(TS `MESHLET_BUILD_BUDGETS.sourceVertices`)。
pub const SOURCE_VERTICES_BUDGET: u64 = 16_777_216;

/// 构建预算:源三角形数上限(TS `MESHLET_BUILD_BUDGETS.sourceTriangles`)。
pub const SOURCE_TRIANGLES_BUDGET: u64 = 4_000_000;

/// 构建预算:输出簇数上限(TS `MESHLET_BUILD_BUDGETS.outputMeshlets`)。
pub const OUTPUT_MESHLETS_BUDGET: u64 = 4_000_000;

/// 构建预算:DAG 全层输出三角形总量上限(TS `MeshletDagOptions.outputTriangleBudget` 缺省)。
pub const OUTPUT_TRIANGLE_BUDGET_DEFAULT: u64 = 8_000_000;

/// 索引化三角形网格输入(位置为紧凑 XYZ,f32)。
#[derive(Debug, Clone)]
pub struct IndexedGeometry {
    /// 紧凑 XYZ 顶点位置,长度为 3 的倍数。
    pub positions: Vec<f32>,
    /// 三角形索引,长度为 3 的倍数,取值必须落在顶点范围内。
    pub indices: Vec<u32>,
}

impl IndexedGeometry {
    /// 顶点数(positions 元素数 / 3)。
    #[must_use]
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    /// 三角形数(indices 元素数 / 3)。
    #[must_use]
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
}

/// 单个簇(贪心装箱结果的一部分):局部顶点表与打包的局部三角形。
#[derive(Debug, Default)]
pub(crate) struct PendingMeshlet {
    /// 全局顶点 → 局部索引。
    local_by_global: rustc_hash_lite::FxHashMap<u32, u32>,
    /// 全局顶点表(按首次出现序,与 TS `pending.vertices` 一致)。
    pub(crate) vertices: Vec<u32>,
    /// 打包局部三角形(pack_local_triangle 结果)。
    pub(crate) triangles: Vec<u32>,
    /// 非退化三角形单位法线(f64 精度,与 TS 一致)。
    pub(crate) normals: Vec<[f64; 3]>,
    /// 出现过退化三角形则法向锥禁用。
    pub(crate) has_degenerate: bool,
}

impl PendingMeshlet {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 判断全局顶点是否已在当前簇内。
    #[inline]
    pub(crate) fn contains_global(&self, global: u32) -> bool {
        self.local_by_global.contains_key(&global)
    }

    /// 取全局顶点的局部索引,不存在则追加(首次出现序)。
    pub(crate) fn local_vertex(&mut self, global: u32) -> u32 {
        if let Some(&existing) = self.local_by_global.get(&global) {
            return existing;
        }
        let local = self.vertices.len() as u32;
        self.local_by_global.insert(global, local);
        self.vertices.push(global);
        local
    }
}

/// 轻量 FxHash 哈希表:避免引入完整 rustc-hash 依赖,同时保持 O(1) 插入查询。
/// 仅在本 crate 内部使用,键为 u32,无 DoS 放大面。
pub(crate) mod rustc_hash_lite {
    /// FxHasher(Browner-speed hash,与 rustc-hash 同族常数)。
    #[derive(Default)]
    pub(crate) struct FxHasher(u64);

    impl std::hash::Hasher for FxHasher {
        #[inline]
        fn write_u32(&mut self, v: u32) {
            self.0 = (self.0.rotate_left(5) ^ u64::from(v)).wrapping_mul(0x517c_c1b7_2722_0a95);
        }

        #[inline]
        fn write_usize(&mut self, v: usize) {
            self.write_u64(v as u64);
        }

        #[inline]
        fn write_u64(&mut self, v: u64) {
            self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x517c_c1b7_2722_0a95);
        }

        #[inline]
        fn write(&mut self, bytes: &[u8]) {
            for &b in bytes {
                self.0 = (self.0.rotate_left(5) ^ u64::from(b)).wrapping_mul(0x517c_c1b7_2722_0a95);
            }
        }

        #[inline]
        fn finish(&self) -> u64 {
            self.0
        }
    }

    /// 以 FxHasher 为后端的 `HashMap` 别名。
    pub(crate) type FxHashMap<K, V> =
        std::collections::HashMap<K, V, std::hash::BuildHasherDefault<FxHasher>>;

    /// 以 FxHasher 为后端的 `HashSet` 别名。
    pub(crate) type FxHashSet<K> =
        std::collections::HashSet<K, std::hash::BuildHasherDefault<FxHasher>>;
}
