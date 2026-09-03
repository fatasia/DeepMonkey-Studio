import type {
  PprBopVersionDraft,
  PprWorkInstructionVisualReference,
  PprWorkInstructionQualityCheck,
  PprWorkInstructionSafetyNote,
  PprWorkInstructionStep,
} from "@bim-studio/contracts";

type PprWorkInstructionPlanSource = Pick<PprBopVersionDraft, "name" | "operations">;

export interface PprWorkInstructionOperationPreview {
  sequence: number;
  operationId: string;
  operationName: string;
  standardTimeMinutes: number;
  steps: PprWorkInstructionStep[];
  safetyNotes: PprWorkInstructionSafetyNote[];
  qualityChecks: PprWorkInstructionQualityCheck[];
  visualReferences: PprWorkInstructionVisualReference[];
}

export interface PprWorkInstructionPreview {
  planName: string;
  operations: PprWorkInstructionOperationPreview[];
  totalStepCount: number;
  totalQualityControlCount: number;
}

/**
 * 把 EWI 投影为稳定的阅读顺序。有效拓扑序优先；校验未通过时，
 * 未进入拓扑序的工序仍按草稿原顺序补在末尾，避免作者内容从预览中消失。
 */
export function buildPprWorkInstructionPreview(
  plan: PprWorkInstructionPlanSource,
  topologicalOrder: string[] = [],
): PprWorkInstructionPreview {
  const byId = new Map(plan.operations.map((operation) => [operation.id, operation]));
  const seen = new Set<string>();
  const orderedIds = [...topologicalOrder, ...plan.operations.map((operation) => operation.id)]
    .filter((operationId) => byId.has(operationId) && takeFirst(operationId, seen));

  const operations = orderedIds.flatMap((operationId, index): PprWorkInstructionOperationPreview[] => {
    const operation = byId.get(operationId)!;
    const instruction = operation.workInstruction;
    if (!instruction) return [];
    return [{
      sequence: index + 1,
      operationId,
      operationName: operation.name,
      standardTimeMinutes: operation.standardTimeMinutes,
      steps: cloneArray(instruction.steps),
      safetyNotes: cloneArray(instruction.safetyNotes),
      qualityChecks: cloneArray(instruction.qualityChecks),
      visualReferences: cloneArray(instruction.visualReferences),
    }];
  });

  return {
    planName: plan.name,
    operations,
    totalStepCount: operations.reduce((total, operation) => total + operation.steps.length, 0),
    totalQualityControlCount: operations.reduce((total, operation) => total + operation.qualityChecks.length, 0),
  };
}

function takeFirst(id: string, seen: Set<string>): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

function cloneArray<T extends object>(items: T[] | undefined): T[] {
  return Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
}
