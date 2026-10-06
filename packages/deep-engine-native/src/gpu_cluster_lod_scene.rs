//! 场景包 → `.dgc` 驻留摄入(场景级聚合;TS `assetClusterLodIngest` 的 native 对端)。
//!
//! 缺口裁决(manifest virtual-geometry 行原记"场景包→.dgc 驻留摄入仍缺"):上传/导入
//! 几何在 TS 侧按实例材质分节产出 `.dgc`(见 deep-engine `assetClusterLodIngest.ts`,
//! 材质绑定取舍——按实例材质分节 vs 单 DAG bindless——已在彼处裁决并登记);本模块是
//! native 运行时侧的摄入端:逐节走既有 [`ClusterLodDagRuntime::from_dgc`] 单节链
//! (read_dgc 全校验 → 路 4 映射 → 合同签核),再过 CPU 驻留预检
//! ([`validate_cluster_lod_residency`],与 `ClusterLodGpuRuntime::new` 的 CPU 侧前件
//! 同一把关,过检即保证该节可经既有 a60de15a GPU 驻留链构造),材质实例绑定记录在节上。
//!
//! == fail-closed(绝不静默丢几何) ==
//! - 单节失败(.dgc 解析/驻留预检)→ 显式 [`ClusterLodSceneFallback`] 记录
//!   (geometry/material/原因/细节),其余节照常摄入——该节几何在调用方保持普通 draw
//!   路径,绝不静默降级;
//! - 合同违约(空场景、空 geometry_id/material_id、重复 (geometry, material) 节)→
//!   整体 `Err`,不带病输出。
//!
//! == GPU 与 pass 调用点(如实边界) ==
//! 本模块只做 CPU 摄入与预检;逐节 `ClusterLodGpuRuntime::new` 构造与渲染 pass 逐节
//! `encode_draws` 的生产调用点属后续切片(真机验证留串行窗口),消费面经
//! [`ClusterLodSceneRuntime::sections`] / [`ClusterLodSceneRuntime::section_for`]。
use crate::gpu_cluster_lod_dag::ClusterLodDagRuntime;
use crate::gpu_cluster_lod_runtime::validate_cluster_lod_residency;

/// 摄入输入:一节 = (几何身份, 材质身份, `.dgc` 字节)。来自场景包发布链的材质分节。
pub struct ClusterLodSceneSectionInput<'a> {
    pub geometry_id: &'a str,
    pub material_id: &'a str,
    pub dgc: &'a [u8],
}

/// 摄入成功的一节:既有单节运行时 DAG + 材质实例绑定(节内全部簇顶点共享该材质实例,
/// 由 TS 分节的构造保证;此处如实记录绑定关系供 pass 消费)。
#[derive(Debug)]
pub struct ClusterLodSceneSection {
    pub geometry_id: String,
    pub material_id: String,
    pub dag: ClusterLodDagRuntime,
}

/// 单节回退原因:`DgcParse` = `.dgc` 解析/合同链失败;`ResidencyPrecheck` = 结构合法
/// 但超出 GPU 驻留预检预算(节点表/层覆盖/三角形域/拼接表规模)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClusterLodSceneFallbackReason {
    DgcParse,
    ResidencyPrecheck,
}

/// 显式回退记录:该节几何保持普通 draw 路径,原因与细节如实上浮,绝不静默。
#[derive(Clone, Debug)]
pub struct ClusterLodSceneFallback {
    pub geometry_id: String,
    pub material_id: String,
    pub reason: ClusterLodSceneFallbackReason,
    pub detail: String,
}

/// 场景级簇 LOD 摄入产物:成功节集 + 显式回退集。
#[derive(Debug)]
pub struct ClusterLodSceneRuntime {
    sections: Vec<ClusterLodSceneSection>,
    fallbacks: Vec<ClusterLodSceneFallback>,
}

/// 整体合同违约(与单节数据失败区分:数据失败回退,合同违约整体 Err)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClusterLodSceneRuntimeError {
    GeometryIdRequired,
    MaterialIdRequired,
    /// 同一 (geometry, material) 节重复;同 geometry 不同 material 分节合法(分节本意)。
    DuplicateSection { geometry_id: String, material_id: String },
    EmptyScene,
}

impl ClusterLodSceneRuntime {
    /// 逐节摄入:from_dgc → 驻留预检 → 绑定记录;单节失败入 fallback,其余照常。
    ///
    /// # Errors
    /// 空场景 / 空 geometry_id / 空 material_id / 重复 (geometry, material) 节。
    pub fn from_sections<'a>(
        sections: impl IntoIterator<Item = ClusterLodSceneSectionInput<'a>>,
    ) -> Result<Self, ClusterLodSceneRuntimeError> {
        let mut ingested: Vec<ClusterLodSceneSection> = Vec::new();
        let mut fallbacks: Vec<ClusterLodSceneFallback> = Vec::new();
        for input in sections {
            let geometry_id = input.geometry_id;
            if geometry_id.is_empty() {
                return Err(ClusterLodSceneRuntimeError::GeometryIdRequired);
            }
            if input.material_id.is_empty() {
                return Err(ClusterLodSceneRuntimeError::MaterialIdRequired);
            }
            if ingested.iter().any(|section| {
                section.geometry_id == geometry_id && section.material_id == input.material_id
            }) {
                return Err(ClusterLodSceneRuntimeError::DuplicateSection {
                    geometry_id: geometry_id.to_string(),
                    material_id: input.material_id.to_string(),
                });
            }
            match ingest_section(geometry_id, input.material_id, input.dgc) {
                Ok(section) => ingested.push(section),
                Err(fallback) => fallbacks.push(fallback),
            }
        }
        if ingested.is_empty() && fallbacks.is_empty() {
            return Err(ClusterLodSceneRuntimeError::EmptyScene);
        }
        Ok(Self { sections: ingested, fallbacks })
    }

    /// 成功摄入节集(顺序 = 输入序;pass 消费面逐节构造 GPU 驻留)。
    pub fn sections(&self) -> &[ClusterLodSceneSection] {
        &self.sections
    }

    /// 显式回退集(调用方据此保持这些节的普通 draw 路径并上报诊断)。
    pub fn fallbacks(&self) -> &[ClusterLodSceneFallback] {
        &self.fallbacks
    }

    /// 材质绑定查找:pass 侧按 (geometry, material) 取节(节内簇顶点绑定该材质实例)。
    pub fn section_for(&self, geometry_id: &str, material_id: &str) -> Option<&ClusterLodSceneSection> {
        self.sections.iter().find(|section| {
            section.geometry_id == geometry_id && section.material_id == material_id
        })
    }

    /// 节点总量(全部节之和;驻留预算证据)。
    pub fn total_node_count(&self) -> usize {
        self.sections.iter().map(|section| section.dag.nodes.len()).sum()
    }
}

/// 单节摄入:from_dgc(解析/合同链)→ 驻留预检;失败落 fallback(带原因与细节)。
fn ingest_section(
    geometry_id: &str,
    material_id: &str,
    dgc: &[u8],
) -> Result<ClusterLodSceneSection, ClusterLodSceneFallback> {
    let fallback = |reason: ClusterLodSceneFallbackReason, detail: String| ClusterLodSceneFallback {
        geometry_id: geometry_id.to_string(),
        material_id: material_id.to_string(),
        reason,
        detail,
    };
    let dag = ClusterLodDagRuntime::from_dgc(dgc, geometry_id)
        .map_err(|error| fallback(ClusterLodSceneFallbackReason::DgcParse, error.to_string()))?;
    validate_cluster_lod_residency(&dag).map_err(|detail| {
        fallback(ClusterLodSceneFallbackReason::ResidencyPrecheck, detail)
    })?;
    Ok(ClusterLodSceneSection {
        geometry_id: geometry_id.to_string(),
        material_id: material_id.to_string(),
        dag,
    })
}
