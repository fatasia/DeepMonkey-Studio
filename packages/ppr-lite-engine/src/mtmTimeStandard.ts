import type { MtmCodeApplication, MtmCodeApplicationEntry } from "@bim-studio/contracts";

/**
 * MTM 工时分解 → 标准工时推导与线平衡桥接(P0-B)。
 * 标准工时 = Σ(minutesPerApplication×count) + 固定值(装夹/加工程序);
 * MTM 数据卡不随包,code→minutes 的数值由调用方提供并已填进 minutesPerApplication,
 * 本模块只做求和、校验与桥接,不内置任何 MTM 代码库数值。
 */

/** 单工序分解结果;derived 区分"MTM 分解推导"与"手填 fallback"。 */
export interface MtmStandardTimeResolution {
  standardTimeMinutes: number;
  derived: boolean;
  /** 仅 derived 时有值:代码求和部分,便于审计分解口径。 */
  codeSumMinutes?: number;
  setupMinutes?: number;
  processingMinutes?: number;
}

/** 校验并推导单工序标准工时;application 缺省时返回 fallback(derived=false)。 */
export function resolveStandardTime(
  application: MtmCodeApplication | null | undefined,
  fallbackMinutes: number,
): MtmStandardTimeResolution {
  if (application === null || application === undefined) {
    if (!Number.isFinite(fallbackMinutes) || fallbackMinutes < 0) throw new Error("fallback 标准工时必须为非负有限数");
    return { standardTimeMinutes: fallbackMinutes, derived: false };
  }
  assertApplication(application);
  let codeSum = 0;
  for (const entry of application.codes) codeSum += entry.minutesPerApplication * entry.count;
  const setup = application.overrides?.setupMinutes ?? 0;
  const processing = application.overrides?.processingMinutes ?? 0;
  return {
    standardTimeMinutes: codeSum + setup + processing,
    derived: true,
    codeSumMinutes: codeSum,
    setupMinutes: setup,
    processingMinutes: processing,
  };
}

export interface MtmOperationBridgeInput {
  readonly id: string;
  readonly standardTimeMinutes: number;
}

/**
 * 桥接:用 MTM 分解结果填充 operations 的 standardTimeMinutes,返回新数组。
 * 未被任何分解覆盖的工序保持原对象原值;不修改传入数组,不改线平衡函数签名。
 */
export function applyMtmToOperations<O extends MtmOperationBridgeInput>(
  operations: readonly O[],
  applications: readonly MtmCodeApplication[],
): O[] {
  const byOperation = new Map<string, MtmCodeApplication>();
  for (const application of applications) {
    assertApplication(application);
    if (byOperation.has(application.operationId)) {
      throw new Error(`工序 ${application.operationId} 存在多条 MTM 分解,口径不唯一`);
    }
    byOperation.set(application.operationId, application);
  }
  const known = new Set(operations.map((operation) => operation.id));
  for (const application of applications) {
    if (!known.has(application.operationId)) {
      throw new Error(`MTM 分解指向不存在的工序:${application.operationId}`);
    }
  }
  return operations.map((operation) => {
    const application = byOperation.get(operation.id);
    if (!application) return operation;
    return { ...operation, standardTimeMinutes: resolveStandardTime(application, operation.standardTimeMinutes).standardTimeMinutes };
  });
}

/** 合同错误立即抛出:code 非空、count≥1 整数、minutes≥0、固定值非负。 */
function assertApplication(application: MtmCodeApplication): void {
  if (!application.operationId || !application.operationId.trim()) throw new Error("MTM 分解缺少 operationId");
  if (!Array.isArray(application.codes) || application.codes.length === 0) {
    throw new Error(`工序 ${application.operationId} 的 MTM 分解至少需要一条代码应用`);
  }
  application.codes.forEach(assertEntry.bind(null, application.operationId));
  const setup = application.overrides?.setupMinutes;
  const processing = application.overrides?.processingMinutes;
  if (setup !== undefined && (!Number.isFinite(setup) || setup < 0)) {
    throw new Error(`工序 ${application.operationId} 的 setupMinutes 必须为非负有限数`);
  }
  if (processing !== undefined && (!Number.isFinite(processing) || processing < 0)) {
    throw new Error(`工序 ${application.operationId} 的 processingMinutes 必须为非负有限数`);
  }
}

function assertEntry(operationId: string, entry: MtmCodeApplicationEntry): void {
  if (!entry.code || !entry.code.trim()) throw new Error(`工序 ${operationId} 存在空 MTM 代码`);
  if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
    throw new Error(`工序 ${operationId} 的 MTM 代码 ${entry.code} 应用次数必须为 ≥1 的整数`);
  }
  if (!Number.isFinite(entry.minutesPerApplication) || entry.minutesPerApplication < 0) {
    throw new Error(`工序 ${operationId} 的 MTM 代码 ${entry.code} 分钟数必须为非负有限数`);
  }
}
