//! J4 能力协商 —— native(deep-engine-native)端渲染能力自检声明。
//!
//! 独立小模块:只消费 TS 合同生成的金样 JSON 与本 crate 既有模块事实,
//! 不改任何既有渲染文件。与 TS 侧同形:
//! - 合同:`packages/contracts/src/rendererCapabilityManifest.ts`
//!   (词汇 supported/degraded/unavailable + 封闭原因码 + 文件证据);
//! - 金样:`packages/contracts/fixtures/renderer-capability-manifest.json`
//!   (由 contracts 测试生成并提交,本模块 include_str! 消费 —— 仓内惯例见
//!   `probe_gi_wgsl.rs` 对 deep-engine WGSL 的跨包 include_str!)。
//!
//! 漂移检测(三层独立):
//! 1. 金样解析失败/词汇非法 → cargo test 红;
//! 2. 本模块 [`NATIVE_RENDERER_CAPABILITY_SELF_CHECK`] 与金样 native 列
//!    支持档/原因码不一致 → 红(native 实际面变了而清单未更新);
//! 3. 清单 id 覆盖不全(缺行/多行)→ 红。
//!
//! 纪律:native 新增/删除/降级任何渲染能力,必须同步更新 TS 登记表并重生成金样。

use serde::{Deserialize, Serialize};

pub const RENDERER_CAPABILITY_CONTRACT_VERSION: u32 = 1;

const MANIFEST_JSON: &str =
    include_str!("../../contracts/fixtures/renderer-capability-manifest.json");

/// 支持档词汇(与 TS `RENDERER_CAPABILITY_SUPPORT_VOCABULARY` 逐词一致)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RendererCapabilitySupport {
    Supported,
    Degraded,
    Unavailable,
}

/// 原因码封闭词汇(kebab-case,与 TS `RENDERER_CAPABILITY_REASON_CODES` 逐词一致)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RendererCapabilityReasonCode {
    /// 该端完整实现,语义达到能力定义。
    Full,
    /// 完整实现但默认关闭(opt-in)。
    OptInDefaultOff,
    /// 仅验收/参考 harness,非运行时通路。
    HarnessOnly,
    /// 有实现,但范围/档位低于能力定义。
    ReducedTier,
    /// 该端没有实现。
    Absent,
    /// 底层 API 缺席(如 wgpu 30 不暴露 ray tracing)。
    ApiMissing,
    /// 能力按设计只属于某类宿主。
    HostSpecific,
}

/// 支持档 → 合法原因码集合。必须与 TS `REASON_PAIRS_FOR_SUPPORT` 逐词一致。
pub fn allowed_reasons(
    support: RendererCapabilitySupport,
) -> &'static [RendererCapabilityReasonCode] {
    match support {
        RendererCapabilitySupport::Supported => &[
            RendererCapabilityReasonCode::Full,
            RendererCapabilityReasonCode::OptInDefaultOff,
            RendererCapabilityReasonCode::HarnessOnly,
        ],
        RendererCapabilitySupport::Degraded => &[
            RendererCapabilityReasonCode::OptInDefaultOff,
            RendererCapabilityReasonCode::HarnessOnly,
            RendererCapabilityReasonCode::ReducedTier,
        ],
        RendererCapabilitySupport::Unavailable => &[
            RendererCapabilityReasonCode::Absent,
            RendererCapabilityReasonCode::ApiMissing,
            RendererCapabilityReasonCode::HostSpecific,
        ],
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityEndDeclaration {
    pub support: RendererCapabilitySupport,
    pub reason: RendererCapabilityReasonCode,
    pub evidence: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityManifestEntry {
    pub id: String,
    pub title: String,
    pub web_feature_keys: Vec<String>,
    pub web: CapabilityEndDeclaration,
    pub native: CapabilityEndDeclaration,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_quality_vocabulary: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityManifestFile {
    pub contract_version: u32,
    pub entries: Vec<CapabilityManifestEntry>,
}

/// 解析并校验金样清单(解析失败/结构缺失直接 panic,由测试兜底成红)。
pub fn parse_manifest() -> CapabilityManifestFile {
    let manifest: CapabilityManifestFile = serde_json::from_str(MANIFEST_JSON)
        .expect("renderer capability manifest golden JSON must parse");
    assert_eq!(
        manifest.contract_version, RENDERER_CAPABILITY_CONTRACT_VERSION,
        "manifest contract version drift: regenerate fixtures/renderer-capability-manifest.json"
    );
    for entry in &manifest.entries {
        for (name, decl) in [("web", &entry.web), ("native", &entry.native)] {
            assert!(
                allowed_reasons(decl.support).contains(&decl.reason),
                "manifest entry {} [{name}] support {:?} forbids reason {:?}",
                entry.id,
                decl.support,
                decl.reason
            );
        }
    }
    manifest
}

/// native 端一行自检声明。
pub struct NativeCapabilitySelfCheck {
    pub capability_id: &'static str,
    pub support: RendererCapabilitySupport,
    pub reason: RendererCapabilityReasonCode,
    /// 本 crate 内证据(模块/符号)。
    pub evidence: &'static str,
}

/// native 端能力自检(初始基线 2026-09-29,逐条按当前 crate 事实填写)。
/// support/reason 必须与金样清单 native 列逐词一致,由本模块测试强制。
pub const NATIVE_RENDERER_CAPABILITY_SELF_CHECK: &[NativeCapabilitySelfCheck] = &[
    NativeCapabilitySelfCheck {
        capability_id: "material-abi-192b",
        support: RendererCapabilitySupport::Degraded,
        reason: RendererCapabilityReasonCode::ReducedTier,
        evidence: "mesh_abi::MATERIAL_UNIFORM_FLOATS=40(160B 核心块;Web 192B 打包的扩展带零填充回退)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "gi-probe-directions",
        support: RendererCapabilitySupport::Degraded,
        reason: RendererCapabilityReasonCode::ReducedTier,
        evidence: "probe_gi_abi 96B 布局合同 + renderer::native_gi_producer 直光种子;无 32 方向辐射内核",
    },
    NativeCapabilitySelfCheck {
        capability_id: "sdf-gi",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无场景 SDF 烘焙/天光圆锥追踪/探针 SH 更新通路(probe_gi_abi 仅 96B 布局合同+直光种子)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "contact-shadows",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 contact shadow 模块(shadow 通路仅 cascaded/local)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "auto-exposure",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 auto exposure 模块",
    },
    NativeCapabilitySelfCheck {
        capability_id: "temporal-upscale",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "native 原生分辨率直出,无上采样通路",
    },
    NativeCapabilitySelfCheck {
        capability_id: "virtual-textures",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 virtual texture 模块",
    },
    NativeCapabilitySelfCheck {
        capability_id: "debug-full-render",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 TAA/TSR 历史链(排查开关仅 web 后处理链路,native 直出无时域 pass)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "ray-traced-shadows",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 compute BVH/帧内联遮挡射线模块(方向光阴影走 cascaded_shadow;web RT 阴影见 deep-engine rayTracing/shadowRayFrame*)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "ray-traced-reflections",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 compute BVH 反射 closest-hit 通道(与 ray-traced-shadows 同口径;web 反射通道见 deep-engine rayTracing/rayTraceClosestFrame*)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "cluster-lod",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "gpu_lod 为传统 mesh/实例 LOD,非 meshlet 簇 LOD;无软光栅后备",
    },
    NativeCapabilitySelfCheck {
        capability_id: "white-furnace-conservation",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::HarnessOnly,
        evidence: "white_furnace CPU 判据/容差逐式移植 TS(字面量测试锁定)+renderer::white_furnace_gpu_tests 球腿/墙腿真机 GPU 门;背景腿 clear 色链与 SSR 判据缺位为宿主差异,如实声明",
    },
    NativeCapabilitySelfCheck {
        capability_id: "device-recovery",
        support: RendererCapabilitySupport::Degraded,
        reason: RendererCapabilityReasonCode::ReducedTier,
        evidence: "app::recovery DeviceLost→整渲染器重建;UncapturedError→failed+手动 R 重建;无错误分型/恢复阶段机/次数预算",
    },
    NativeCapabilitySelfCheck {
        capability_id: "ssr",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 SSR 模块",
    },
    NativeCapabilitySelfCheck {
        capability_id: "fog-volumetric",
        support: RendererCapabilitySupport::Degraded,
        reason: RendererCapabilityReasonCode::ReducedTier,
        evidence: "fog::FogSettings.volumetric = 屏幕空间固定步线性深度积分,非 froxel 体积管线",
    },
    NativeCapabilitySelfCheck {
        capability_id: "taa",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "直出通路无时域历史/TAA",
    },
    NativeCapabilitySelfCheck {
        capability_id: "ambient-occlusion",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 SSAO/AO 通路",
    },
    NativeCapabilitySelfCheck {
        capability_id: "bloom",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "bloom_pipeline::BloomPass(bloom/bloom_pass/bloom_pipeline;quality_profile 有界预算)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "tonemap-display",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "runtime_package::solid_environment output-transform native-aces-v1/native-aces-light-v2;author_grading 在 ACES 前 HDR 域",
    },
    NativeCapabilitySelfCheck {
        capability_id: "author-grading-vignette",
        support: RendererCapabilitySupport::Degraded,
        reason: RendererCapabilityReasonCode::ReducedTier,
        evidence: "author_grading::switches vignette 槽位保留、本切片恒未启用;六通道分级已镜像",
    },
    NativeCapabilitySelfCheck {
        capability_id: "ground-preview",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "runtime_package::solid_environment 仅背景底,无内置地面/网格",
    },
    NativeCapabilitySelfCheck {
        capability_id: "ibl-environment",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "renderer::ibl GpuIblEnvironment(gpu_ibl + ibl)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "texture-arrays",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "texture_array_bindings::MATERIAL_UNIFORM_BINDING(texture_array_packing 打包与 Web 同源)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "visibility-buffer",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 visibility buffer 通路",
    },
    NativeCapabilitySelfCheck {
        capability_id: "occlusion-culling",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "gpu_culling::GpuCulling(gpu_occlusion*;renderer::hi_z_pyramid R4 opt-in)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "gpu-lod",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "renderer::lod GpuLod(lod_contract 与 Web 合同同源)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "shadow-cascades",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "cascaded_shadow + cascaded_shadow_math(renderer shadow_map CascadedShadowGpuMetrics)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "shadow-local",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "local_shadow(16 spot entries/16-view frame ABI; point light consumes six faces;local_lighting + clustered_lighting 共用)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "weighted-oit",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 OIT 模块",
    },
    NativeCapabilitySelfCheck {
        capability_id: "spatial-aa",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 FXAA/空间 AA 后处理",
    },
    NativeCapabilitySelfCheck {
        capability_id: "hardware-ray-query",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::ApiMissing,
        evidence: "host_capabilities::rt_probe probe_adapter=wgpu 30 无 RT 特性(BackendLacksRtApi);rt_residency 仅驻留+绑定",
    },
    NativeCapabilitySelfCheck {
        capability_id: "ies-lighting",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "ies_shading 字节布局镜像 WebGPU E02 表",
    },
    NativeCapabilitySelfCheck {
        capability_id: "material-layered-304b",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::OptInDefaultOff,
        evidence: "pbr_layered.rs LAYERED_SURFACE_BLOCK_BYTES=304 逐字节镜像 TS 布局;求值响应级混合 CPU 参考;layered_*_gpu_tests",
    },
    NativeCapabilitySelfCheck {
        capability_id: "material-clearcoat",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "mesh_abi::MATERIAL_UNIFORM_FLOATS=40(核心块;不消费 Web 扩展带 40..46,无清漆层叠着色路径)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "material-advanced",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "runtime package native profile 拒绝 advancedParameters;mesh_abi::MATERIAL_UNIFORM_FLOATS=40(核心块,无 advanced 带与 sheen/薄膜/体积着色路径)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "local-shadow-abi-16",
        support: RendererCapabilitySupport::Degraded,
        reason: RendererCapabilityReasonCode::ReducedTier,
        evidence: "mesh_abi FRAME_ABI_ID=deep.native.frame.v8(16 lights/16 shadow views/16 softness)+local_shadow MAX_SPOT_SHADOWS=16(点光≤1×6 face);frame v8 与 TS 布局未跨端逐字节对齐验证,如实降档",
    },
    NativeCapabilitySelfCheck {
        capability_id: "device-recovery-bridge",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::HostSpecific,
        evidence: "app::recovery 宿主恢复消费已在 device-recovery 行登记;Studio WebGPU 桥消费策略属 web 宿主专属",
    },
    NativeCapabilitySelfCheck {
        capability_id: "atmosphere-sky",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无大气散射/环境源模块(native 直出光栅化;天空源按设计属 web PbrRenderer 的 radiance-hdr/studio 环境)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "hdr-display-output",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 HDR 显示输出模块(native 离屏直出经 output-transform ACES SDR;显示 surface 链按设计属 web 宿主)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "object-outline",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "outline_pass.rs OutlinePass + native_outline_composite_v1.wgsl 掩码/合成(实例 outline 字段共用 surface flag bit 256)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "megalights",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 MegaLights 模块(native clustered_lighting 为逐灯簇光路径,非 RIS 采样;web M1 compute 通路见 deep-engine lighting/megaLights*)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "virtual-geometry",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 meshlet DAG 页调度/驻留/indirect 分组运行时(Brief-Nanite 离线工具链 geometry_dag 属独立切片;web M3 CPU 侧调度通路见 deep-engine virtualGeometryDagPages/Scheduling/Residency/Indirect)",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn self_check(id: &str) -> &NativeCapabilitySelfCheck {
        NATIVE_RENDERER_CAPABILITY_SELF_CHECK
            .iter()
            .find(|row| row.capability_id == id)
            .unwrap_or_else(|| panic!("native self-check missing capability {id}"))
    }

    /// 金样可解析、合同版本一致、双端声明配对合法(漂移检测第 1 层)。
    #[test]
    fn golden_manifest_parses_with_valid_vocabulary() {
        let manifest = parse_manifest();
        assert!(
            manifest.entries.len() >= 27,
            "manifest baseline shrunk unexpectedly"
        );
        let mut ids: Vec<&str> = manifest
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        let expected_order: Vec<&str> = ids.clone();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(
            ids.len(),
            expected_order.len(),
            "duplicate capability ids in manifest"
        );
    }

    /// 覆盖率:金样清单每个能力 id 必须有 native 自检声明(缺任一行红)。
    #[test]
    fn every_manifest_capability_has_native_declaration() {
        let manifest = parse_manifest();
        let missing: Vec<&str> = manifest
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .filter(|id| {
                NATIVE_RENDERER_CAPABILITY_SELF_CHECK
                    .iter()
                    .all(|row| row.capability_id != *id)
            })
            .collect();
        assert!(
            missing.is_empty(),
            "native self-check missing capabilities: {missing:?}"
        );
    }

    /// 自检不得声明清单之外的能力(防双清单各自生长)。
    #[test]
    fn native_self_check_has_no_extra_capabilities() {
        let manifest = parse_manifest();
        let extra: Vec<&str> = NATIVE_RENDERER_CAPABILITY_SELF_CHECK
            .iter()
            .map(|row| row.capability_id)
            .filter(|id| !manifest.entries.iter().any(|entry| entry.id == *id))
            .collect();
        assert!(
            extra.is_empty(),
            "native self-check declares unknown capabilities: {extra:?}"
        );
    }

    /// 同形对拍:native 自检的支持档/原因码必须与金样 native 列逐词一致
    /// (native 实际面变化而 TS 清单未更新 → 这里红;反向由 contracts 测试红)。
    #[test]
    fn native_self_check_matches_manifest_native_column() {
        let manifest = parse_manifest();
        for entry in &manifest.entries {
            let row = self_check(&entry.id);
            assert_eq!(
                row.support, entry.native.support,
                "support drift on {}",
                entry.id
            );
            assert_eq!(
                row.reason, entry.native.reason,
                "reason drift on {}",
                entry.id
            );
        }
    }

    /// 原因码配对规则与 TS REASON_PAIRS_FOR_SUPPORT 同构(本端自检行同样受约束)。
    #[test]
    fn native_self_check_reason_pairs_are_valid() {
        for row in NATIVE_RENDERER_CAPABILITY_SELF_CHECK {
            assert!(
                allowed_reasons(row.support).contains(&row.reason),
                "native self-check {} support {:?} forbids reason {:?}",
                row.capability_id,
                row.support,
                row.reason
            );
        }
    }
}
