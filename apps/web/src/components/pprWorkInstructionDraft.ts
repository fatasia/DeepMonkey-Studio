import type {
  PprElectronicWorkInstruction,
  PprExternalReference,
  PprWorkInstructionQualityCheck,
  PprWorkInstructionVisualReference,
} from "@bim-studio/contracts";

export function createPprWorkInstruction(
  planReferences: PprExternalReference[] | undefined,
  operationReferences: PprExternalReference[] | undefined,
): PprElectronicWorkInstruction {
  return {
    steps: [{ id: "step-1", instruction: "" }],
    safetyNotes: [],
    qualityChecks: [],
    visualReferences: availablePprVisualReferences(planReferences, operationReferences),
  };
}

export function availablePprVisualReferences(
  planReferences: PprExternalReference[] | undefined,
  operationReferences: PprExternalReference[] | undefined,
  selectedReferences?: PprExternalReference[] | undefined,
): PprWorkInstructionVisualReference[] {
  const seen = new Set<string>();
  return [...(operationReferences ?? []), ...(planReferences ?? []), ...(selectedReferences ?? [])].flatMap((reference) => {
    const id = reference.id.trim();
    const key = `${reference.kind}:${id}`;
    if ((reference.kind !== "scene" && reference.kind !== "object") || !id || seen.has(key)) return [];
    seen.add(key);
    return [{ kind: reference.kind, id }];
  });
}

export function nextPprInstructionItemId(
  instruction: PprElectronicWorkInstruction,
  prefix: "step" | "safety" | "quality",
): string {
  const ids = new Set([
    ...instruction.steps.map((item) => item.id),
    ...instruction.safetyNotes.map((item) => item.id),
    ...instruction.qualityChecks.map((item) => item.id),
  ]);
  let sequence = 1;
  while (ids.has(`${prefix}-${sequence}`)) sequence += 1;
  return `${prefix}-${sequence}`;
}

export function addPprQualityControl(
  instruction: PprElectronicWorkInstruction,
): PprElectronicWorkInstruction {
  return {
    ...instruction,
    qualityChecks: [...instruction.qualityChecks, {
      id: nextPprInstructionItemId(instruction, "quality"),
      checkpoint: "",
    }],
  };
}

export function duplicatePprQualityControl(
  instruction: PprElectronicWorkInstruction,
  qualityControlId: string,
): PprElectronicWorkInstruction {
  const sourceIndex = instruction.qualityChecks.findIndex((item) => item.id === qualityControlId);
  if (sourceIndex < 0) return instruction;
  const source = instruction.qualityChecks[sourceIndex]!;
  const copy: PprWorkInstructionQualityCheck = {
    ...source,
    id: nextPprInstructionItemId(instruction, "quality"),
    ...(source.samplingFrequency ? { samplingFrequency: { ...source.samplingFrequency } } : {}),
  };
  return {
    ...instruction,
    qualityChecks: [
      ...instruction.qualityChecks.slice(0, sourceIndex + 1),
      copy,
      ...instruction.qualityChecks.slice(sourceIndex + 1),
    ],
  };
}

export function togglePprVisualReference(
  instruction: PprElectronicWorkInstruction,
  reference: PprWorkInstructionVisualReference,
  selected: boolean,
): PprElectronicWorkInstruction {
  const key = `${reference.kind}:${reference.id}`;
  const remaining = (instruction.visualReferences ?? []).filter((item) => `${item.kind}:${item.id}` !== key);
  return {
    ...instruction,
    visualReferences: selected ? [...remaining, reference] : remaining,
  };
}
