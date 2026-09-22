export function evaluateIndustrialStageDelta(text) {
  const stages = [...String(text ?? "").matchAll(/^\|\s*(S[1-6])\s*\|/gm)].map((match) => match[1]);
  const unique = new Set(stages);
  return { stages, completeStageMatrix: unique.size === 6 && stages.length === 6 && ["S1", "S2", "S3", "S4", "S5", "S6"].every((id) => unique.has(id)), explicitGaps: /本轮待办|剩余|项目级后验收/.test(String(text ?? "")) };
}
