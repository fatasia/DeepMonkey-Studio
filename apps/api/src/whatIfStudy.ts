import { randomUUID } from "node:crypto";
import {
  evaluateWhatIfOperatingEnvelope,
  type WhatIfStudyRecord,
  type WhatIfStudyRequest,
} from "@bim-studio/studio-core";

export function runWhatIfStudy(
  projectId: string,
  request: WhatIfStudyRequest,
  now = new Date().toISOString(),
): WhatIfStudyRecord {
  const name = request.name?.trim().slice(0, 80) || "未命名 What-if 工况";
  const input = structuredClone(request.input);
  const result = evaluateWhatIfOperatingEnvelope(input);
  return {
    id: randomUUID(),
    projectId,
    name,
    input,
    result,
    createdAt: now,
    execution: {
      engineId: "deterministic-local-elasticity-envelope",
      engineVersion: "1.0.0",
      inputFingerprint: result.inputFingerprint,
      deterministic: true,
    },
  };
}

export function reproduceWhatIfStudy(
  projectId: string,
  source: WhatIfStudyRecord,
  now = new Date().toISOString(),
): WhatIfStudyRecord {
  const reproduced = runWhatIfStudy(projectId, { name: source.name, input: source.input }, now);
  return { ...reproduced, reproductionOf: source.id };
}
