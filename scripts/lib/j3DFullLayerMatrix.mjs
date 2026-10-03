// J3-D-full 逐层双端对拍:合法差异矩阵 v1、层 evidence 校验与聚合(CPU 侧,无 GPU 执行)。
// 层/门目录唯一真源在 packages/deep-engine/lab/j3DFullLayerMatrix.ts,由 runner 经 esbuild 载入;
// 本模块只负责:差异矩阵登记、evidence 合同校验(错层/错门/证据过期必须 FAIL)与聚合 evidence 结构。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export const hash = value => createHash("sha256").update(value).digest("hex");

/** 每层的必备门绑定(与 lab REQUIRED_LAYER_GATE 同步;runner 载入 lab 目录后逐条核对)。 */
export const REQUIRED_LAYER_GATES = Object.freeze({
  "geometry-coverage": "geometry-depth-interior", "main-depth": "geometry-depth-interior",
  normal: "normal-quantized-angle", "shadow-visibility": "shadow-half-interval",
  "hdr-color": "hdr-flat-strict", "post-bloom": "post-half-store",
  "post-fog": "post-half-store", display: "display-byte",
  "texture-coverage": "texture-hdr-coverage",
});

/**
 * 合法差异矩阵 v1(2026-09-30 冻结基线):已知双端合法差异逐条登记,含证据引用。
 * rule = 允许域(超出即缺陷);status: confirmed=已有实测证据, diagnostic=只诊断不设等值门。
 */
export const LEGAL_DIFFERENCE_MATRIX_V1 = Object.freeze([
  Object.freeze({ id: "LD-01", layer: ["geometry-coverage", "main-depth", "hdr-color"],
    difference: "Native 主目标 4xMSAA vs Web 1x 采样",
    host: { web: "PBR_MAIN_SAMPLE_COUNT=1 (renderTargets.ts)", native: "FORWARD_SAMPLE_COUNT=4 (mesh_abi.rs)" },
    rule: "轮廓/棱线差异仅允许 1px 几何边界; 全覆盖内部稳定域严格比较(Native 4 样本均值 vs Web 中心)",
    evidence: ["docs/specs/j3-gate-d-geometry-depth-20260930.md", "packages/deep-engine/src/webgpu/renderTargets.ts",
      "packages/deep-engine-native/src/mesh_abi.rs"], status: "confirmed" }),
  Object.freeze({ id: "LD-02", layer: ["main-depth"],
    difference: "主深度格式与观察方式: Depth24Plus 4xMSAA 逐样本 vs depth32float 中心样本",
    host: { web: "PBR_DEPTH_FORMAT depth32float", native: "FORWARD_DEPTH_FORMAT Depth24Plus + multsample 观察" },
    rule: "深度比较只在双方全覆盖内部稳定像素; 边界 1px 内差异合法",
    evidence: ["docs/specs/j3-gate-d-geometry-depth-20260930.md"], status: "confirmed" }),
  Object.freeze({ id: "LD-03", layer: ["hdr-color"],
    difference: "Raster 双端均消费视图域导数粗糙度; 材质粗糙度下限仍不同",
    host: { web: "deepViewGeometryRoughness + 粗糙度下限 0.06", native: "native_view_geometry_roughness + 粗糙度下限 0.045; RT 无片元导数" },
    rule: "共同 raster 平法线稳定域仍走严格 0.002 门; 下限差与 RT 导数缺失单独诊断,不得按实测拟合容差",
    evidence: ["docs/specs/j3-gate-d-hdr-normal-current-state-20260930.md", "docs/specs/c8-native-geometry-roughness-20260930.md"], status: "confirmed" }),
  Object.freeze({ id: "LD-04", layer: ["hdr-color", "display"],
    difference: "直射已双端同源 r185 DFG; IBL 积分纹理预算仍为合法宿主差异",
    host: { web: "直射 deepDirectDfg185; IBL 默认128²积分纹理", native: "直射同一 wgsl/directDfgLut185.wgsl; IBL 内置32²×128样本" },
    rule: "直射 DFG 源差已消除,不得作为直射残差豁免; IBL 不同纹理预算仍单独诊断,共同严格门关 IBL",
    evidence: ["packages/deep-engine/src/webgpu/directDfgLut185.ts", "packages/deep-engine/wgsl/directDfgLut185.wgsl", "docs/specs/c8-native-dfg-correlated-20260930.md"],
    status: "diagnostic" }),
  Object.freeze({ id: "LD-05", layer: ["post-bloom"],
    difference: "Bloom 合法算法/默认档不同: Web box5级/整数5tap/0.5重建 vs Native 半分辨率±0.25采样/分数5tap/radius1",
    host: { web: "threshold1.25 softKnee.2 intensity.55 maxLevels5", native: "threshold1 softKnee.5 intensity.14 radius1" },
    rule: "各宿主对独立 CPU 参考 half-store 门(abs≤.003+|ref|*.004); 跨算法逐像素等值不是门",
    evidence: ["docs/specs/j2-b6-bloom-texture-matrix-20260930.md", "packages/deep-engine/fixtures/j3-bloom-texture-v1.json"],
    status: "confirmed" }),
  Object.freeze({ id: "LD-06", layer: ["post-fog"],
    difference: "Fog 合法域不同: Native 有 exponential/steps1/height 域 1-256 且无作者 linear 合同; Web steps32-64/scaleHeight>0/作者 linear+8步volume",
    host: { web: "VolumetricFogPass march HG 含 1/(4π)", native: "OutputPass relative HG 分母 floor .01 / clamp 0..4" },
    rule: "按各自公式全像素 half-store 门; 模式差异登记,不强迫同值",
    evidence: ["docs/specs/j2-b6-fog-profile-matrix-20260930.md", "packages/deep-engine/fixtures/j3-fog-profiles-v1.json"],
    status: "confirmed" }),
  Object.freeze({ id: "LD-07", layer: ["shadow-visibility"],
    difference: "CSM 级联合同与 uniform ABI: Native 级联合法域 2..4/21vec4(336B), Web 支持 1/39vec4(624B); depth-fit 矩阵各自独立",
    host: { web: "CascadedShadowResources 从 extent 派生 shadowFar/padding", native: "fit_light_depth 纳入 active_bounds" },
    rule: "共同严格矩阵仅 4 级联; visibility 以 binary16 区间相交判定,不比较点值; 各自原始 uniform 保存",
    evidence: ["docs/specs/j3-gate-d-shadow-hdr-visibility-current-state-20260930.md"], status: "confirmed" }),
  Object.freeze({ id: "LD-08", layer: ["normal"],
    difference: "法线附件域与格式: Web viewNormal rgba8unorm(视图域) vs Native opt-in worldNormal(世界域)",
    host: { web: "PBR_VIEW_NORMAL_FORMAT rgba8unorm", native: "NormalCaptureTargets worldNormal+roughness" },
    rule: "Web viewNormal 经正式相机基转换到 world 域后比较; UNORM8 单端量化角界 0.389°,双端门 +.01°",
    evidence: ["docs/specs/j3-gate-d-normal-shadow-current-state-20260930.md"], status: "confirmed" }),
  Object.freeze({ id: "LD-09", layer: ["hdr-color"],
    difference: "默认宿主光照不同: Web 默认主灯 ray[-1.6,-2.8,-1.2]色[2.5,2.4,2.25]+次灯, Native legacy 太阳[3.2,3.0,2.8]+IBL 开",
    host: { web: "省略 lights 时的默认 ray 灯", native: "frame_data legacy sun" },
    rule: "HDR 对拍必须走共同 authored-single-sun 档(surfaceToLight[0,0.6,0.8]); 默认宿主档只作一轮诊断",
    evidence: ["docs/specs/j3-gate-d-hdr-normal-current-state-20260930.md"], status: "confirmed" }),
  Object.freeze({ id: "LD-10", layer: ["display"],
    difference: "显示域非中性分级/曝光档两端各有扩展; 共同档为曝光1+Narkowicz ACES+无分级",
    host: { web: "pbrOutputShader 输出家族", native: "OutputColorProfile 扩展档" },
    rule: "共同档字节门≤1/255、SSIM≥0.999; 非中性档由 C8 WGSL/GLSL 浮点库另验(≤2e-5),不从共同档推断",
    evidence: ["docs/specs/j3-gate-d-output-first-cut-20260930.md"], status: "confirmed" }),
  Object.freeze({ id: "LD-11", layer: ["hdr-color", "post-bloom", "post-fog", "shadow-visibility"],
    difference: "HDR 存储同为 rgba16float,但数值受 binary16 量化: 相邻 half 数台阶是物理真值区间而非噪声",
    host: { web: "rgba16float", native: "Rgba16Float" },
    rule: "阈值两侧比较必须用 half 区间/含幅度项门; 禁止把量化台阶拟合成常量 epsilon",
    evidence: ["scripts/lib/j3ShadowVisibilityIntervals.mjs", "packages/deep-engine/lab/j3BloomTextureReference.ts"],
    status: "confirmed" }),
  Object.freeze({ id: "LD-12", layer: ["hdr-color", "geometry-coverage"],
    difference: "背景 clear 语义: 数值附件背景取 Native 默认线性 RGB[0.012,0.020,0.035], Web 取同值",
    host: { web: "同值配置", native: "默认背景" },
    rule: "背景不属于材质对拍域; 两端背景必须同为冻结值,角点须读出 clear 以防 discard 零初始化误判",
    evidence: ["docs/specs/j3-gate-d-texture-coverage-20260930.md"], status: "confirmed" }),
  Object.freeze({ id: "LD-13", layer: ["shadow-visibility", "hdr-color"],
    difference: "MSAA 观察接缝: Native 观察走 encode_opaque_pass(retain_depth=true) 非 discard 快路径; Web 生产 hdr/depth 直读",
    host: { web: "生产附件直读", native: "FrameObservation 分支" },
    rule: "默认生产路径行为保持原样; 观察分支不得改变生产 quality/shader; 角点远平面 clear=1 为双方前置判据",
    evidence: ["docs/specs/j3-gate-d-geometry-depth-20260930.md"], status: "confirmed" }),
  Object.freeze({ id: "LD-14", layer: ["display", "hdr-color"],
    difference: "纹理/采样语义: Web 单样本 opaque + Weighted OIT, Native 4xMSAA + 排序 alpha",
    host: { web: "transparency.currentColor 为最终透明输出", native: "opaque pass 排序 alpha" },
    rule: "共同透明语义仅限单个非重叠层; 重叠层 OIT 一致性不在 J3-D-full 范围",
    evidence: ["docs/specs/j3-gate-d-texture-coverage-20260930.md"], status: "diagnostic" }),
  Object.freeze({ id: "LD-15", layer: ["hdr-color"],
    difference: "直射高光峰双实现(GLSL/WGSL) f32 路径差 × RGBA16F 量化: 亮度≥4 区 1 half-ulp(.0039@4) 已超 .002 绝对门",
    host: { web: "Three 原生 BRDF_GGX_Multiscatter 直射路径", native: "FrameObservation 分支" },
    rule: "仅当 max 差像素呈 half-ulp 阶梯形态(差=±k·ulp(亮度))且数值路径已同源(DFG 表/公式/visibility)时适用; 符号判据按 2026-10-02 修订执行: 全域符号混合, D 尖峰邻域因增益符号一致可解释局部单符号(原『局部 3×3 邻域符号混合』必要条件经最坏局部实测证伪, 废止); 跨域引用以 LD-16 为准; 系统性同号差不得援引本条",
    evidence: ["docs/specs/c8-s9-local-direct-multiscattering-20260930.md", "docs/specs/j3-d-full-cpu-prep-20261001.md", "docs/specs/c8-ld16-ld17-adjudication-20261002.md"], status: "diagnostic" }),
  Object.freeze({ id: "LD-16", layer: ["hdr-color"],
    difference: "直射 GGX 主瓣区双后端 fp32 算术调度差(点积 ≤4-6 ULP) × D 尖峰(denom≈1.6-2.0e-3, dSpec/dnh≈2.9e5-5.8e5) × D3D RTZ 存储: 亮度 4.1-6.6 区 1-2 half-ulp(0.0039-0.0078) 超 .002 门",
    host: { web: "Three r185 via WebGL/ANGLE(D3D11)", native: "生产 PBR plain via WebGPU/Dawn(D3D12)" },
    rule: "同时满足: (1)数值源同源——等输入 CPU 全式对照差 ≤1e-7 相对; (2)阶梯形态——存储差=±k·ulp(亮度) 且两侧 prestore F32 距 RTZ 格点 <1 step(F32 差 ≤1.5 ULP); (3)输入差 ≤6 fp32 ULP 且其×该像素 D 灵敏度覆盖观测输出差; (4)全域符号混合——局部单符号以 D 尖峰邻域增益解释; 系统性 >1.5 ULP F32 同号差不得援引(远斜归 LD-17); 仅作归因, 不构成 .002 门豁免",
    evidence: ["docs/specs/c8-ld16-ld17-adjudication-20261002.md", "docs/specs/c8-eight-channel-convergence-20261002.md",
      "test-output/c8-eight-channel-convergence-20261002/progress-02-attribution.json", "test-output/c8-eight-channel-convergence-20261002/consumed-mrt.json",
      "test-output/c8-input-chain-20261001/conclusion.json"], status: "diagnostic" }),
  Object.freeze({ id: "LD-17", layer: ["hdr-color"],
    difference: "后端 ddx helper-lane 关联差 × geometryRoughness(远斜实测 deep 0.088566518 vs three ≈0.0808-0.0823) → 粗糙金属区持续同号存储差 ≤10 half-ulp@0.26",
    host: { web: "Three r185 lights_physical_fragment geometryRoughness(非扰动法线 dFdx/dFdy)", native: "生产 deepViewGeometryRoughness(视图域法线 dpdx/dpdy)" },
    rule: "同时满足: (1)该像素 roughness 双侧实测差 ≥2/256 且等输入对照差 ≤1e-7 相对; (2)双侧 ddx/dy 分别匹配 CPU 平面外推的相邻行/列(误差 <2.2e-4); (3)差为粗糙金属主瓣连贯区形态, 非孤立翻转; (4)跨通道比值消去解得的 roughness 与独立 ddx 实测一致; shader 语义层不可修(候选 A GPU 实测 6225 改善/6125 恶化零净修复, 候选 B no-op); 仅作归因, 不构成 .002 门豁免; 若后端行为变化(驱动/Chrome 升级)须重新验证",
    evidence: ["docs/specs/c8-ld16-ld17-adjudication-20261002.md", "docs/specs/c8-eight-channel-convergence-20261002.md", "docs/specs/c8-full-chain-closure-audit-20261001.md",
      "test-output/c8-eight-channel-convergence-20261002/progress-04-fresh-closure.json", "test-output/c8-eight-channel-convergence-20261002/gpu-far-output/evidence.json"], status: "diagnostic" }),
]);

/** 新发现差异登记格式(追加条目必须过此校验;拒绝无证据引用或撞号的条目)。 */
export function registerLegalDifference(matrix, entry) {
  const required = ["id", "layer", "difference", "host", "rule", "evidence", "status"];
  for (const key of required) if (entry[key] === undefined) throw Error(`Legal difference missing "${key}"`);
  if (!/^LD-\d{2,}$/.test(entry.id)) throw Error(`Legal difference id "${entry.id}" must match LD-\\d{2,}`);
  if (matrix.some(existing => existing.id === entry.id)) throw Error(`Duplicate legal difference id ${entry.id}`);
  const known = new Set(Object.keys(REQUIRED_LAYER_GATES));
  for (const layer of entry.layer) if (!known.has(layer)) throw Error(`Unknown layer "${layer}" in ${entry.id}`);
  if (!["confirmed", "diagnostic"].includes(entry.status)) throw Error(`Invalid status "${entry.status}"`);
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0
    || entry.evidence.some(item => typeof item !== "string"))
    throw Error(`Legal difference ${entry.id} needs non-empty evidence citations`);
  for (const item of entry.evidence) {
    if (/^(docs|packages|scripts)\//.test(item) && !existsSync(item))
      throw Error(`Legal difference ${entry.id} cites missing evidence file: ${item}`);
  }
  return [...matrix, Object.freeze({ ...entry })];
}

/** 校验单层 evidence 合同。expectedIdentity 为 runner 现算的源身份(可选);freshRequired 时拒绝历史档。 */
export function validateLayerEvidence(layer, evidence, { expectedIdentity, expectedSources, freshRequired = false, evidenceMode = "live" } = {}) {
  if (!evidence) throw Error(`Layer ${layer.id} evidence missing`);
  if (typeof evidence.scope !== "string" || !layer.scopePrefixes.some(prefix => evidence.scope.startsWith(prefix)))
    throw Error(`wrong-layer evidence: scope "${evidence.scope}" does not match layer ${layer.id} contracts ${JSON.stringify(layer.scopePrefixes)}`);
  const requiredGate = REQUIRED_LAYER_GATES[layer.id];
  if (layer.gateId !== requiredGate)
    throw Error(`wrong-gate binding: layer ${layer.id} bound to "${layer.gateId}", contract requires "${requiredGate}"`);
  if (evidence.gateId !== undefined && evidence.gateId !== requiredGate)
    throw Error(`wrong-gate evidence: ${layer.id} evidence declares gate "${evidence.gateId}", contract requires "${requiredGate}"`);
  if (evidence.passed !== true) throw Error(`Layer ${layer.id} evidence reports failure`);
  if (evidence.stable === false) throw Error(`Layer ${layer.id} evidence reports instability`);
  if (layer.id === "normal" && (evidence.normals?.passed !== true || evidence.normals.stable !== true))
    throw Error("Layer normal requires passed, stable normals attachment evidence");
  if (freshRequired && evidence.currentRun !== true)
    throw Error(`Layer ${layer.id} historical receipt presented as fresh (currentRun=${evidence.currentRun})`);
  if (!freshRequired && evidenceMode === "live" && evidence.currentRun === true
    && evidence.execution === "historical file comparison; no host executed")
    throw Error(`Layer ${layer.id} historical comparison must not claim currentRun=true`);
  const sources = evidence.sourceIdentity?.sources ?? evidence.sourceIdentity;
  if (freshRequired && (!sources || !expectedSources))
    throw Error(`Layer ${layer.id} lacks verified production source identity`);
  if (sources) {
    const entries = Object.entries(sources);
    if (!entries.length || !entries.some(([file]) => /^packages\/.+\/(src|wgsl)\//.test(file))
      || entries.some(([file, value]) => !/^(?:(packages|apps|scripts)\/|package\.json$|pnpm-lock\.yaml$)/.test(file)
        || file.split("/").includes("..") || typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)))
      throw Error(`Layer ${layer.id} invalid production source identity`);
    if (expectedSources) for (const [file, recorded] of entries) {
      if (expectedSources[file] !== recorded)
        throw Error(`stale production evidence: ${layer.id} consumed source changed or missing: ${file}`);
    }
  }
  if (layer.freshnessKey) {
    const recorded = evidence[layer.freshnessKey];
    if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded))
      throw Error(`Layer ${layer.id} evidence lacks recorded ${layer.freshnessKey} identity`);
    if (expectedIdentity !== undefined && recorded !== expectedIdentity)
      throw Error(`stale evidence: ${layer.id} recorded ${layer.freshnessKey} ${recorded.slice(0, 12)}… != current source ${String(expectedIdentity).slice(0, 12)}…`);
  }
  return true;
}

/** 聚合层矩阵 evidence:格网行 + 合法差异矩阵 + 执行语义。compare=true 时仅读历史,currentRun 恒 false。 */
export async function aggregateLayerMatrix({ layers, loadEvidence, identityOf, sourcesOf, cellsOf, compare }) {
  const grid = [], notes = [];
  for (const layer of layers) {
    let evidence;
    try { evidence = await loadEvidence(layer); }
    catch { throw Error(`Layer ${layer.id} evidence missing`); }
    const expectedIdentity = layer.freshnessKey && identityOf ? identityOf(layer) : undefined;
    const expectedSources = sourcesOf ? await sourcesOf(layer, evidence) : undefined;
    validateLayerEvidence(layer, evidence, { expectedIdentity, expectedSources, freshRequired: !compare });
    const cells = cellsOf(layer);
    if (!cells.length || cells.some(cell => typeof cell.cellId !== "string" || !cell.cellId.length
      || !["web+native", "web-only", "native-only"].includes(cell.hostScope))
      || new Set(cells.map(cell => cell.cellId)).size !== cells.length)
      throw Error(`Layer ${layer.id} scene cells missing, invalid or duplicated`);
    for (const cell of cells) {
      grid.push({ layerId: layer.id, cellId: cell.cellId, hostScope: cell.hostScope,
        gateId: layer.gateId, evidenceDir: layer.evidenceDir });
    }
    if (!evidence.sourceIdentity) notes.push(`${layer.id}: no production source digest; historical receipt cannot certify fresh`);
  }
  return { schema: "j3-d-full-layer-matrix-v1", passed: true, stable: true, currentRun: !compare,
    grid, legalDifferenceMatrix: LEGAL_DIFFERENCE_MATRIX_V1,
    freshnessNotes: notes,
    excluded: ["cross-host post-process pixel equality", "smooth-cube HDR equality", "overlapping transparency/OIT",
      "whole-scene product visual quality", "frame performance"],
    execution: compare ? "historical receipts only; no host executed" : "fresh receipts required for every layer" };
}
