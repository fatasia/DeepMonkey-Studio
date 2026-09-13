/** 电池运行目录只登记产品实际调用链，排除备份、消融和一次性实验模型。 */
export type BatteryModelFamily =
  | "electrothermal"
  | "spm-conservation"
  | "socformer"
  | "bmsformer"
  | "batterymformer"
  | "batterymformer-pinn"
  | "spm-pino-transformer"
  | "twin-moe";

export type BatteryArtifactStatus = "production" | "active-shadow" | "fallback" | "awaiting-artifact";
export type BatteryModelRole =
  | "primary-model"
  | "primary-baseline"
  | "routed-expert"
  | "production-router"
  | "shadow-expert"
  | "shadow-router"
  | "safety-fallback";
export type BatteryOutputAuthority = "primary" | "advisory" | "fallback";
export type BatteryTask = "soc" | "soh" | "rul" | "safety" | "multi-physics" | "expert-routing";

/** 目录版本用于证据追溯；模型内容变化时必须显式升级，不能只改展示名称。 */
export const BATTERY_MODEL_CATALOG_VERSION = "battery-production-catalog-v2";

export type BatteryInputDomainStatus = "supported" | "indeterminate" | "out-of-domain";

export interface BatteryInputDomainEvidence {
  status: BatteryInputDomainStatus;
  reasons: string[];
  metrics: Readonly<Record<string, number | string | boolean>>;
}

export interface BatteryInferenceModelIdentity {
  catalogVersion: string;
  catalogFingerprint: string;
  modelId: FormalBatteryPrimaryModelId;
  modelVersion: string;
  checkpointSha256?: string;
  artifactSha256?: string;
  runtimeAdapterSha256?: string;
  inputContract?: string;
  outputContract?: string;
  /** 归一化统计包含在签名适配器中，此处记录其发布合同版本。 */
  normalizationVersion?: string;
  postprocessingVersion?: string;
}

/** 每次推理都返回不含原始业务数据的最小证据，供故障复盘和版本审计。 */
export interface BatteryInferenceEvidence {
  schemaVersion: 1;
  traceId: string;
  inputFingerprint: string;
  startedAt: string;
  durationMs: number;
  authority: BatteryOutputAuthority;
  routingPolicy: "primary-python" | "approved-onnx-with-python-fallback" | "routed-expert-python" | "local-validation-onnx";
  requestedRuntime: "python-service" | "onnx";
  actualRuntime: "python-service" | "onnx";
  fellBack: boolean;
  fallbackReason?: string;
  confidence: "high" | "medium" | "low" | "unknown";
  domain: BatteryInputDomainEvidence;
  model: BatteryInferenceModelIdentity;
}

export interface BatteryModelEvidence {
  gate: "high" | "experimental-high" | "research" | "deterministic" | "production-routing";
  passed: boolean;
  source: string;
  summary: string;
  metrics?: Readonly<Record<string, number>>;
}

export interface BatteryModelCatalogEntry {
  id: string;
  family: BatteryModelFamily;
  label: string;
  tasks: readonly BatteryTask[];
  runtime: "python-service" | "onnx" | "deterministic";
  status: BatteryArtifactStatus;
  role: BatteryModelRole;
  outputAuthority: BatteryOutputAuthority;
  runtimeEnabled: boolean;
  sourceCheckpoint: string;
  modelVersion: string;
  chemistryScope: readonly ("lfp" | "ncm" | "na-ion")[];
  /** 固定生产主输出占比；动态路由专家保持为 0，由 productionEligible 表示可被正式选中。 */
  productionTraffic: number;
  /** 动态专家不拥有固定权重，但可以被正式路由选择。 */
  productionEligible?: boolean;
  executionMode:
    | "standard"
    | "observe-compare-audit"
    | "always-available"
    | "risk-triggered"
    | "dynamic-risk-routed"
    | "production-router";
  evidence: BatteryModelEvidence;
}

/**
 * 保持源工程的专家路由逻辑：标准模型先行，物理风险触发 PINN；TwinMoE 在
 * 电热轻专家、PINO 与 SPM 回退之间选路。动态专家没有固定权重，只有路由结果拥有主输出权。
 */
export const BATTERY_MODEL_CATALOG: readonly BatteryModelCatalogEntry[] = [
  {
    id: "battery.bmsformer", family: "bmsformer", label: "BMSFormer · 在线 SOH 与容量估计",
    tasks: ["soh"], runtime: "python-service", status: "production", role: "primary-model", outputAuthority: "primary", runtimeEnabled: true,
    sourceCheckpoint: "models/bmsformer-batterylife-expanded.pt", modelVersion: "bmsformer-li-multichem-v2",
    chemistryScope: ["lfp", "ncm"], productionTraffic: 1, executionMode: "standard",
    evidence: { gate: "high", passed: true, source: "checkpoint.confidence_gate", summary: "LFP/NCM 高置信门通过，70 个测试电芯。", metrics: { testMae: 0.0023588717449456453, testCells: 70 } }
  },
  {
    id: "battery.socformer", family: "socformer", label: "SOCFormer · SOC 深度校正",
    tasks: ["soc"], runtime: "python-service", status: "production", role: "primary-model", outputAuthority: "primary", runtimeEnabled: true,
    sourceCheckpoint: "models/socformer-batterylife-expanded.pt", modelVersion: "socformer-li-hybrid-v2",
    chemistryScope: ["lfp", "ncm"], productionTraffic: 1, executionMode: "standard",
    evidence: { gate: "high", passed: true, source: "checkpoint.confidence_gate", summary: "LFP/NCM 高置信门通过，70 个测试电芯。", metrics: { testMae: 0.018071787431836128, testCells: 70 } }
  },
  {
    id: "battery.batterymformer", family: "batterymformer", label: "BatteryMFormer · SOH 退化轨迹与 RUL",
    tasks: ["soh", "rul"], runtime: "python-service", status: "production", role: "primary-model", outputAuthority: "primary", runtimeEnabled: true,
    sourceCheckpoint: "checkpoints/batterymformer-expanded/model.safetensors", modelVersion: "batterymformer-expanded",
    chemistryScope: ["lfp", "ncm"], productionTraffic: 1, executionMode: "standard",
    evidence: {
      gate: "high",
      passed: true,
      source: "checkpoint.confidence_gate + HUST whole-source external holdout",
      summary: "标准专家在已覆盖数据域通过 high 门槛（29 个测试电芯）；HUST 77 电芯全来源外部留出未达跨域门槛，运行时只允许 medium。",
      metrics: {
        testMae: 0.010455230250954628,
        testMape: 1.2129676,
        testCells: 29,
        hustExternalCells: 77,
        hustExternalSohMae: 0.1460658311843872,
        hustExactEolMaeCycles: 1168.4615384615386,
        hustRightCensoredConsistency: 0.4117647058823529,
      },
    }
  },
  {
    id: "battery.electrothermal-baseline", family: "electrothermal", label: "电热工程基线 · 孪生主轨迹",
    tasks: ["soc", "multi-physics", "safety"], runtime: "deterministic", status: "production", role: "primary-baseline", outputAuthority: "primary", runtimeEnabled: true,
    sourceCheckpoint: "research/digital_twin.py::_simulate_baseline", modelVersion: "engineering-baseline-v1",
    chemistryScope: ["lfp", "ncm", "na-ion"], productionTraffic: 1, executionMode: "always-available",
    evidence: { gate: "deterministic", passed: true, source: "research/digital_twin.py", summary: "数字孪生始终先计算确定性电热基线，提交状态也以基线为准。" }
  },
  {
    id: "battery.batterymformer-pinn", family: "batterymformer-pinn", label: "BatteryMFormer PINN · 物理路由专家",
    tasks: ["soh", "rul", "multi-physics"], runtime: "onnx", status: "production", role: "routed-expert", outputAuthority: "advisory", runtimeEnabled: true,
    sourceCheckpoint: "checkpoints/batterymformer-physics/model.safetensors", modelVersion: "batterymformer-spm-pinn-v9-fieldcal-seed7181",
    chemistryScope: ["lfp", "ncm"], productionTraffic: 0, productionEligible: true, executionMode: "dynamic-risk-routed",
    evidence: { gate: "production-routing", passed: true, source: "batterymformer-physics/confidence_gate.json", summary: "标准专家出现物理风险时执行；通过完整性、置信与分歧保护后可由正式路由采纳。", metrics: { testMape: 1.3223 } }
  },
  {
    id: "battery.spm-pino", family: "spm-pino-transformer", label: "SPM-PINO · 多物理路由专家",
    tasks: ["soc", "multi-physics", "safety"], runtime: "onnx", status: "production", role: "routed-expert", outputAuthority: "advisory", runtimeEnabled: true,
    sourceCheckpoint: "checkpoints/research-candidate/spm-pino-v13-6-native-v10-guard-seed2026.pt", modelVersion: "spm-pino-v13.6-native-v10-guard",
    chemistryScope: ["lfp"], productionTraffic: 0, productionEligible: true, executionMode: "dynamic-risk-routed",
    evidence: { gate: "production-routing", passed: true, source: "checkpoint.metadata.gate", summary: "保留源 checkpoint 动态稀疏路由；域内且路由收益为正时可成为正式孪生轨迹。", metrics: { nativeVoltageMaeV: 0.01822087913751602, dynamicP95LatencyMs: 9.9593, samples: 63 } }
  },
  {
    id: "battery.twin-moe", family: "twin-moe", label: "TwinMoE · 正式稀疏专家路由",
    tasks: ["expert-routing", "multi-physics", "safety"], runtime: "onnx", status: "production", role: "production-router", outputAuthority: "primary", runtimeEnabled: true,
    sourceCheckpoint: "checkpoints/research-candidate/spm-pino-v13-6-native-v10-guard-seed2026.pt", modelVersion: "twin-moe-production-route-v1",
    chemistryScope: ["lfp"], productionTraffic: 1, productionEligible: true, executionMode: "production-router",
    evidence: { gate: "production-routing", passed: true, source: "logs/research-candidate/twinmoe-actual-jacobian-stability-v1.json + pino-spm-handoff-vhil-contract-v1.json", summary: "按原动态风险、域判断与 SPM 回退逻辑生成正式路由结果；单个专家不能绕过路由。", metrics: { calibratedConditions: 27, handoffCases: 54, maxNormalizedJump: 0.0957 } }
  },
  {
    id: "battery.spm-fallback", family: "spm-conservation", label: "SPM 守恒求解 · 域外安全回退",
    tasks: ["soc", "multi-physics", "safety"], runtime: "deterministic", status: "fallback", role: "safety-fallback", outputAuthority: "fallback", runtimeEnabled: true,
    sourceCheckpoint: "research/digital_twin.py::_simulate_spm_fallback", modelVersion: "spm-conservation-v1",
    chemistryScope: ["lfp", "ncm", "na-ion"], productionTraffic: 0, executionMode: "risk-triggered",
    evidence: { gate: "deterministic", passed: true, source: "pino-spm-handoff-vhil-contract-v1.json", summary: "域外或极高风险时跳过神经路由并由 SPM 守恒求解接管。", metrics: { handoffCases: 54 } }
  }
];

export function validateBatteryCatalog(entries: readonly BatteryModelCatalogEntry[] = BATTERY_MODEL_CATALOG): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`duplicate:${entry.id}`);
    ids.add(entry.id);
    if (!entry.runtimeEnabled) errors.push(`runtime-disabled:${entry.id}`);
    if (entry.outputAuthority === "primary" && entry.productionTraffic <= 0) errors.push(`primary-traffic:${entry.id}`);
    if (entry.outputAuthority !== "primary" && entry.productionTraffic !== 0) errors.push(`non-primary-traffic:${entry.id}`);
    if (entry.status === "active-shadow" && !["shadow-expert", "shadow-router"].includes(entry.role)) errors.push(`shadow-role:${entry.id}`);
    if (entry.status === "active-shadow" && entry.outputAuthority !== "advisory") errors.push(`shadow-authority:${entry.id}`);
    if (["routed-expert", "production-router"].includes(entry.role) && entry.status !== "production") errors.push(`routed-status:${entry.id}`);
    if (["routed-expert", "production-router"].includes(entry.role) && !entry.productionEligible) errors.push(`routed-eligibility:${entry.id}`);
    if (!entry.evidence.passed) errors.push(`evidence-gate:${entry.id}`);
  }
  return errors;
}

export interface BatteryReleaseAssessment {
  /** 当前目录是否满足“可上线”的模型路由条件；ONNX 不是隐含前提。 */
  ready: boolean;
  blockers: string[];
  warnings: string[];
  primaryModels: string[];
  shadowModels: string[];
  routedModels: string[];
  fallbackModels: string[];
  onnxPrimaryModels: string[];
  onnxMigration: BatteryOnnxMigrationAssessment;
}

export type FormalBatteryPrimaryModelId = "battery.bmsformer" | "battery.socformer" | "battery.batterymformer";

export interface BatteryOnnxOutputComparison {
  task: "soc" | "soh" | "rul";
  samples: number;
  maxAbsoluteError: number;
  meanAbsoluteError: number;
  allowedMaxAbsoluteError: number;
  allowedMeanAbsoluteError: number;
}

/** ONNX 只在这份可复核证据完整通过后，才有资格替换对应 Python 正式模型。 */
export interface BatteryOnnxEquivalenceManifest {
  schemaVersion: 1;
  modelId: FormalBatteryPrimaryModelId;
  source: { modelVersion: string; checkpointSha256: string };
  artifact: { fileName: string; sha256: string; sizeBytes: number; opset: 18; precision: "fp32" };
  /** 前处理、后处理和模型元数据的独立可校验制品；缺失时不得加载裸 ONNX。 */
  runtimeAdapter: { fileName: string; sha256: string; sizeBytes: number; schemaVersion: 1 };
  contract: { input: string; output: string; preprocessing: string; postprocessing: string };
  validation: {
    outputs: BatteryOnnxOutputComparison[];
    boundaryCases: number;
    boundaryPassed: number;
    outOfDomainCases: number;
    outOfDomainPassed: number;
    invalidInputCases: number;
    invalidInputRejected: number;
    repeatRuns: number;
    maxRepeatDrift: number;
    allowedRepeatDrift: number;
    /** 业务链路回放必须覆盖预处理、模型推理与最终后处理，不能只比较裸张量。 */
    businessReplayCases: number;
    businessReplayPassed: number;
  };
  approval: {
    decisionStatus: "candidate" | "production-approved";
    independentDatasetSplit: boolean;
    externalLockboxCases: number;
    approvedBy?: string;
    approvedAt?: string;
    evidenceFingerprint?: string;
  };
  generatedAt: string;
}

export interface BatteryOnnxMigrationAssessment {
  ready: boolean;
  eligibleModelIds: FormalBatteryPrimaryModelId[];
  missingModelIds: FormalBatteryPrimaryModelId[];
  blockers: string[];
}

/**
 * 对生产模型目录做发布前审计。该函数只审计已登记的模型与证据，
 * 不把训练 checkpoint 是否存在、ONNX 是否等价等事实“猜测”为通过。
 */
export function assessBatteryRelease(
  entries: readonly BatteryModelCatalogEntry[] = BATTERY_MODEL_CATALOG,
  onnxManifests: readonly BatteryOnnxEquivalenceManifest[] = []
): BatteryReleaseAssessment {
  const blockers = validateBatteryCatalog(entries).map((error) => `目录校验失败：${error}`);
  const warnings: string[] = [];
  const primaryModels = entries.filter((entry) => entry.outputAuthority === "primary").map((entry) => entry.id);
  const shadowModels = entries.filter((entry) => entry.status === "active-shadow").map((entry) => entry.id);
  const routedModels = entries.filter((entry) => ["routed-expert", "production-router"].includes(entry.role)).map((entry) => entry.id);
  const fallbackModels = entries.filter((entry) => entry.outputAuthority === "fallback").map((entry) => entry.id);
  const onnxPrimaryModels = entries.filter((entry) => entry.role === "primary-model" && entry.runtime === "onnx" && entry.outputAuthority === "primary" && entry.status === "production" && entry.evidence.passed).map((entry) => entry.id);

  for (const task of ["soc", "soh", "rul"] as const) {
    const covered = entries.some((entry) => entry.outputAuthority === "primary" && entry.runtimeEnabled && entry.evidence.passed && entry.tasks.includes(task));
    if (!covered) blockers.push(`缺少 ${task.toUpperCase()} 正式主模型覆盖`);
  }
  if (!entries.some((entry) => entry.role === "safety-fallback" && entry.runtime === "deterministic" && entry.runtimeEnabled && entry.evidence.passed)) {
    blockers.push("缺少可用的确定性安全回退模型");
  }
  if (onnxPrimaryModels.length === 0) warnings.push("当前没有经等价验证的 ONNX 生产主模型；保持 Python 服务为生产运行时，ONNX 只能作为候选迁移目标。");
  if (shadowModels.some((id) => entries.find((entry) => entry.id === id)?.productionTraffic !== 0)) {
    blockers.push("影子模型生产流量必须为 0");
  }
  if (!entries.some((entry) => entry.role === "production-router" && entry.outputAuthority === "primary" && entry.productionEligible)) {
    blockers.push("缺少可用的正式多专家路由");
  }
  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    primaryModels,
    shadowModels,
    routedModels,
    fallbackModels,
    onnxPrimaryModels,
    onnxMigration: assessBatteryOnnxMigration(onnxManifests, entries)
  };
}

const FORMAL_ONNX_MODELS: readonly FormalBatteryPrimaryModelId[] = [
  "battery.bmsformer",
  "battery.socformer",
  "battery.batterymformer"
];

const FORMAL_ONNX_CONTRACTS: Readonly<Record<FormalBatteryPrimaryModelId, BatteryOnnxEquivalenceManifest["contract"]>> = {
  "battery.bmsformer": {
    input: "bmsformer-normalized-health-window-v1",
    output: "soh-fraction-v1",
    preprocessing: "bmsformer-health-window-v1",
    postprocessing: "bmsformer-soh-product-v1",
  },
  "battery.socformer": {
    input: "socformer-normalized-sequence-window-v1",
    output: "soc-fraction-v1",
    preprocessing: "socformer-sequence-anchor-v1",
    postprocessing: "socformer-hybrid-soc-product-v1",
  },
  "battery.batterymformer": {
    input: "batterymformer-early-cycle-multimodal-v1",
    output: "soh-trajectory-and-rul-v1",
    preprocessing: "batterymformer-multimodal-v1",
    postprocessing: "batterymformer-rul-product-v1",
  },
};

/** 分模型验证 ONNX 与当前正式 Python 输出是否等价，不接受只有“文件可加载”的伪门禁。 */
export function assessBatteryOnnxMigration(
  manifests: readonly BatteryOnnxEquivalenceManifest[],
  entries: readonly BatteryModelCatalogEntry[] = BATTERY_MODEL_CATALOG
): BatteryOnnxMigrationAssessment {
  const blockers: string[] = [];
  const eligibleModelIds: FormalBatteryPrimaryModelId[] = [];
  const byModel = new Map(manifests.map((manifest) => [manifest.modelId, manifest]));
  const missingModelIds = FORMAL_ONNX_MODELS.filter((modelId) => !byModel.has(modelId));

  for (const modelId of FORMAL_ONNX_MODELS) {
    const manifest = byModel.get(modelId);
    if (!manifest) { blockers.push(`${modelId} 缺少 ONNX 等价清单`); continue; }
    const catalog = entries.find((entry) => entry.id === modelId);
    const errors = validateOnnxManifest(manifest, catalog);
    if (errors.length > 0) blockers.push(...errors.map((error) => `${modelId}：${error}`));
    else eligibleModelIds.push(modelId);
  }
  if (manifests.length !== byModel.size) blockers.push("存在重复模型的 ONNX 等价清单");
  return { ready: blockers.length === 0, eligibleModelIds, missingModelIds, blockers };
}

function validateOnnxManifest(manifest: BatteryOnnxEquivalenceManifest, catalog: BatteryModelCatalogEntry | undefined): string[] {
  const errors: string[] = [];
  if (!catalog || catalog.role !== "primary-model") errors.push("不是当前正式主模型");
  if (catalog && manifest.source.modelVersion !== catalog.modelVersion) errors.push("源模型版本与当前目录不一致");
  if (!isSha256(manifest.source.checkpointSha256) || !isSha256(manifest.artifact.sha256)) errors.push("checkpoint 或 ONNX SHA-256 无效");
  if (!manifest.artifact.fileName.toLowerCase().endsWith(".onnx") || manifest.artifact.sizeBytes <= 0) errors.push("ONNX 制品信息无效");
  if (
    !manifest.runtimeAdapter
    || !manifest.runtimeAdapter.fileName.toLowerCase().endsWith(".json")
    || !isSha256(manifest.runtimeAdapter.sha256)
    || manifest.runtimeAdapter.sizeBytes <= 0
    || manifest.runtimeAdapter.schemaVersion !== 1
  ) errors.push("运行适配器制品信息无效");
  if (manifest.artifact.opset !== 18 || manifest.artifact.precision !== "fp32") errors.push("首版仅允许 opset 18 / FP32");
  if (Object.values(manifest.contract).some((value) => !value.trim())) errors.push("输入输出或预处理合同版本缺失");
  const expectedContract = FORMAL_ONNX_CONTRACTS[manifest.modelId];
  if (!sameOnnxContract(manifest.contract, expectedContract)) {
    errors.push("输入输出或前后处理合同版本与正式运行时不一致");
  }
  if (!isIsoDate(manifest.generatedAt)) errors.push("清单生成时间无效");
  const requiredTasks = catalog?.tasks.filter((task): task is "soc" | "soh" | "rul" => ["soc", "soh", "rul"].includes(task)) ?? [];
  for (const task of requiredTasks) {
    const output = manifest.validation.outputs.find((candidate) => candidate.task === task);
    if (!output || output.samples <= 0) errors.push(`缺少 ${task.toUpperCase()} 黄金样本对比`);
    else if (output.maxAbsoluteError > output.allowedMaxAbsoluteError || output.meanAbsoluteError > output.allowedMeanAbsoluteError) errors.push(`${task.toUpperCase()} 数值误差超限`);
  }
  const validation = manifest.validation;
  if (validation.boundaryCases <= 0 || validation.boundaryPassed !== validation.boundaryCases) errors.push("边界样本未全部通过");
  if (validation.outOfDomainCases <= 0 || validation.outOfDomainPassed !== validation.outOfDomainCases) errors.push("域外样本未全部触发预期处理");
  if (validation.invalidInputCases <= 0 || validation.invalidInputRejected !== validation.invalidInputCases) errors.push("非法输入未全部拒绝");
  if (validation.repeatRuns < 3 || validation.maxRepeatDrift > validation.allowedRepeatDrift) errors.push("重复运行稳定性未通过");
  if (!Number.isInteger(validation.businessReplayCases) || validation.businessReplayCases < 3 || validation.businessReplayPassed !== validation.businessReplayCases) {
    errors.push("真实业务记录回放未全部通过");
  }
  const approval = manifest.approval;
  if (!approval) {
    errors.push("缺少生产批准信息");
  } else {
    if (approval.decisionStatus !== "production-approved") errors.push("仍是候选清单，未经生产批准");
    if (!approval.independentDatasetSplit) errors.push("缺少独立数据集切分证据");
    if (!Number.isInteger(approval.externalLockboxCases) || approval.externalLockboxCases <= 0) errors.push("缺少外部锁箱样本");
    if (!approval.approvedBy?.trim() || !isIsoDate(approval.approvedAt) || !isSha256(approval.evidenceFingerprint ?? "")) {
      errors.push("生产批准人、时间或证据指纹无效");
    }
    if (isIsoDate(manifest.generatedAt) && isIsoDate(approval.approvedAt)
      && Date.parse(approval.approvedAt!) < Date.parse(manifest.generatedAt)) {
      errors.push("生产批准时间早于清单生成时间");
    }
  }
  return errors;
}

function isSha256(value: string): boolean {
  return /^[a-f\d]{64}$/i.test(value);
}

function sameOnnxContract(
  actual: BatteryOnnxEquivalenceManifest["contract"],
  expected: BatteryOnnxEquivalenceManifest["contract"],
): boolean {
  return (Object.keys(expected) as Array<keyof typeof expected>)
    .every((field) => actual[field] === expected[field]);
}

function isIsoDate(value: string | undefined): boolean {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
