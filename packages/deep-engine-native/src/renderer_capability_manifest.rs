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
    // P1 质量主线(六引擎对标刀位 1,2026-10-06):native SDF-GI 链入库——CPU 权威
    // 镜像与生产 WGSL 单源齐备,真机 GPU 门过;生产 renderer 帧循环接线为后继切片,
    // 如实 harness-only(与 auto-exposure/spatial-aa 同款登记)。
    NativeCapabilitySelfCheck {
        capability_id: "sdf-gi",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::HarnessOnly,
        evidence: "src/sdf_gi_scene.rs(场景 SDF 体积烘焙 CPU 权威镜像:triangleDistance 精确距离+rayX 奇偶定号+逐实例域+min 合成+探针 lattice 推导,TS sdfSceneBake/sdfGrid 逐式同构) + src/sdf_gi_trace.rs(天光圆锥追踪 visibility+hitDistance 双输出+Fibonacci 方向集) + src/sdf_gi_probe_update.rs(L1 SH 投影/bounce 能量哨兵/时域滤波/命中统计归约/窗口计划,记录直供 probe_gi_abi 96B) + src/sdf_gi_wgsl.rs(三个 WGSL 计算核 include_str 单源+校验和双端 Rust 半);对拍 src/sdf_gi_parity_tests.rs 与 TS 权威 fixture 位级(f32 词逐字+SHA-256:1872 cells/24 探针/384 lanes/双帧记录流/初值,唯二跨 libm 哨兵 coneTan≤4ulp 与 targetEnergy≤1e-9) + 真机 src/sdf_gi_gpu_probe_tests.rs(RTX 4060/Vulkan:非翻转 cells 距离逐位 mean=max=0,trace/update 全词逐位 0 误差,烘焙符号翻转 64/1872=3.4%≤5% 预算=WGSL 退化射线文档化限制);如实 harness-only:生产 renderer 帧循环接线后继切片,烘焙哈希缓存子集缺(TS cached 状态恒 0)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "contact-shadows",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无 contact shadow 模块(shadow 通路仅 cascaded/local)",
    },
    // 视觉三件套批(2026-10-06):CPU 移植仲裁实现入库(TS f64 golden 对拍);
    // 生产曝光消费接线为后继切片——如实 harness-only。
    NativeCapabilitySelfCheck {
        capability_id: "auto-exposure",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::HarnessOnly,
        evidence: "postprocess::auto_exposure estimate_luminance_from_equirect/from_prefiltered_mip + target_exposure_from_luminance(±EV 包络)+ PbrAutoExposureRuntime(EV 平滑+率硬顶,fail-closed;TS 序列 1e-9 对拍);曝光消费接线后继切片",
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
    // F2 登记修正(2026-10-06):pipeline/rt.rs 硬件 RT 方向阴影管线族已就位
    // 且生产消费;仅静态 opaque/MASK 批次、web compute BVH 全帧档未镜像,
    // 如实登记 reduced-tier。
    NativeCapabilitySelfCheck {
        capability_id: "ray-traced-shadows",
        support: RendererCapabilitySupport::Degraded,
        reason: RendererCapabilityReasonCode::ReducedTier,
        evidence: "pipeline/rt.rs RtMeshPipelines F2 RT fragment 方向阴影 Ray Query 管线族(静态 opaque/MASK;BLEND 不在 TLAS 驻留;失败 fail-closed 回退栅格)+ renderer/rt_residency 驻留与生产绘制 + renderer/rt_pixel_gpu_tests、rt_raster_parity_gpu_tests 真机 GPU 门;方向光阴影常规档仍走 cascaded_shadow",
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
        capability_id: "ssgi",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "无屏空间 GI 模块",
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
    // 渐晕启用批(2026-10-06):vignette 槽位接活——wire colorGrading 可选
    // vignetteDarkness ∈ [0,3],pack switches=[1,1,1,darkness],WGSL vignette
    // 分支先于分级,CPU 镜像 apply_at;随运行包声明 opt-in,旧包逐字节不变。
    NativeCapabilitySelfCheck {
        capability_id: "author-grading-vignette",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::OptInDefaultOff,
        evidence: "author_grading::new_with_vignette/apply_at(vignette_darkness ∈ [0,3] fail-fast)+ solid_environment AuthorColorGrading.vignette_darkness 解码 + native_output_color.wgsl vignette 分支(四变体调用点);TS pack/apply f32 容差对拍",
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
    // 视觉三件套批(2026-10-06):FXAA 逐式移植入库,真机 GPU 对拍通过;
    // 生产出片链接线为后继切片——如实 harness-only。
    NativeCapabilitySelfCheck {
        capability_id: "spatial-aa",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::HarnessOnly,
        evidence: "postprocess::spatial_aa resolve_spatial_aa_cpu(TS resolveSpatialAaCpu 逐位 golden)+ spatial_aa_shader/create_spatial_aa_pipeline + tests/spatial_aa_gpu 真机 readback 对拍(RTX 4060/Vulkan ≤2/255);OutputPass 接线后继切片",
    },
    // F2 登记修正(2026-10-06):wgpu 30 暴露 EXPERIMENTAL_RAY_QUERY,
    // gpu_context 按适配器门控启用;不足设备保留软件 BVH/栅格路径,
    // 故为 opt-in-default-off 而非 api-missing。
    NativeCapabilitySelfCheck {
        capability_id: "hardware-ray-query",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::OptInDefaultOff,
        evidence: "gpu_context.rs 适配器含 EXPERIMENTAL_RAY_QUERY 才请求 + pipeline/rt.rs enable wgpu_ray_query 像素消费管线族(失败 error-scope fail-closed 回退栅格)+ renderer/rt_residency pixel_pipelines 生产消费 + hardware_ray_query::ray_query_device_ready 合同 + host_capabilities/rt_probe 实验特性探测",
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
    // P1 质量主线(六引擎对标刀位 2,2026-10-05):native MegaLights RIS 链入库——
    // CPU 权威镜像与生产 WGSL 单源齐备,双端 fixture 对拍过;真机 GPU leg 受 wgpu 30
    // naga 编译路径限制(见 megalights_gpu_probe_tests 已知限制),生产 renderer 帧循环
    // 接线为后继切片——如实 harness-only(与 sdf-gi/auto-exposure 同款登记)。
    NativeCapabilitySelfCheck {
        capability_id: "megalights",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::HarnessOnly,
        evidence: "src/megalights_ris.rs(P1 质量主线刀位 2:统一灯池 64B/灯打包 ABI + RIS K=32 WRS 蓄水池 + 时域合并(单候选/深度门 0.1) + 5×5 空间值域无偏平均(源像素评价 W_src/法线门 0.9) + 胜者可见性 mask 只乘 shade 侧(self 本像素/空间源像素) + 穷举参考与穷举模式 + 直射通路选择(≤64 簇光快路径=clustered_lighting 组合,超预算 RIS);TS megaLights.ts/megaLightsRisCpu.ts 逐式同构,f64 中间量) + src/megalights_wgsl.rs(wgsl/megaLightsRis.wgsl 单源 include_str + .sha256 校验和 Rust 半,TS 半 megaLightsRisWgslChecksum.test.ts 同夹具,两半同绿=双端逐字节) + 对拍 src/megalights_parity_tests.rs 与 TS 权威 fixture(fixtures/megalights-native-parity-v1.json,生成器 packages/deep-engine/scripts/generateMegaLightsNativeParity.mts,黄金场景 8×6×12 灯×5 帧覆盖矩阵:空间值域平均/时域合并/EMA/self 回落/穷举/可见性/门分支;RNG 全流与蓄水池结构 winner/m 位级,weightSum f64 ≤1e-9 相对,f32 color 词 ≤2 ulp,唯跨 libm hypot/pow/exp2 哨兵如实) + 真机 src/megalights_gpu_probe_tests.rs(#[ignore];harness/设备对照核全过,但 RIS 核 dispatch 在 wgpu 30 naga 双后端执行期故障=编译路径已知限制,TS 生产 Dawn 同源正常,如实不虚报);如实 harness-only:生产 renderer 帧循环接线后继切片,IES 因子注入与可见性射线档(traceTwoLevelOccluded 家族)缺位",
    },
    NativeCapabilitySelfCheck {
        capability_id: "projected-textures",
        support: RendererCapabilitySupport::Unavailable,
        reason: RendererCapabilityReasonCode::Absent,
        evidence: "packages/deep-engine-native/src/lib.rs(无投影纹理光模块)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "virtual-geometry",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::HarnessOnly,
        evidence: "geometry_dag/src/lib.rs 离线编译工具链(obj.rs→meshlet_builder.rs 贪心簇划分→dag.rs 层级聚类简化 DAG 父子单射→dgc.rs .dgc 流式格式 64B 文件头+88B 段头+8 对齐 payload+逐段 CRC32C+zlib,CLI build/info/verify) + tests/golden_parity.rs 与 TS buildMeshlets/buildMeshletDag 逐位对拍(quick_sphere/synthetic50k 双 fixture 与 TS 测试同源共用) + tests/dgc_byte_golden.rs .dgc 序列化字节黄金钉版(压缩/未压缩双档字节+SHA-256 入库,门常开;TS 跨工具链 decodeDgc 对 Rust 产物 sha256 钉版对拍同源) + tests/cluster_lod_contract.rs 消费合同门(dgcClusterLodBridge 路4 映射镜像+validateClusterLodDag 不变量:节点预算/唯一 id/子层细化/根可达叶子区间并集覆盖/误差单调,反例注入证明门咬人);如实 harness-only:native renderer 页调度/驻留/indirect 分组运行时仍缺,现役消费通路在 web(virtualGeometryDagPages/Scheduling/Residency/Indirect + rayTracing 簇 LOD 波次选层/indirect 计划,经 dgcClusterLodBridge 桥)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "deep2d-visual-trio",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "deep2d/command_types.rs(cornerRadius/shadow + linear/radial paint,legacy 实心 wire 兼容)+ paint_data.rs(WGSL 逐式镜像)+ native_deep2d_v1.wgsl v2 + deep2d_paint_gpu_tests 真 GPU 对拍(内部零分歧)",
    },
    NativeCapabilitySelfCheck {
        capability_id: "deep2d-component-layout",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "deep2d/layout/solve.rs(taffy flex solve → quad/视觉命令产出,零新增命令变体)+ app::deep2d_context::layout_content 引擎缝 + deep2d_layout_gpu_tests 卡片+文本+图标最小样例真 GPU 逐像素对拍",
    },
    NativeCapabilitySelfCheck {
        capability_id: "deep2d-dynamic-path-fill",
        support: RendererCapabilitySupport::Supported,
        reason: RendererCapabilityReasonCode::Full,
        evidence: "deep2d/painter_dynamic.rs(滑窗 8 帧内 ≥3 变更自动分路;资格 gate;预算回落计数)+ painter_cache_prepare 路由 + native_deep2d_dynamic_cover_v1.wgsl + deep2d_dynamic_gpu.rs(clear→cover→fill 三连,Stencil8;nonzero 前向增/背向减,evenodd 双向 Invert 翻 LSB)+ paint_reference dynamic 分支同语义 oracle + deep2d_dynamic_gpu_tests N 帧/fill-rule donut/渐变/scissor/混帧/composite 真 GPU 对拍(内部零分歧,逐像素 worst=0);如实:动态命令 stroke 维持 CPU 展开、边缘为 1× 硬边(与既有静态路一致)",
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
