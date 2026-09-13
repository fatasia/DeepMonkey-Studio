/** 可重跑的内置样例；结果不等于客户数据或已部署模型的验收。 */
export type AiSampleKind = "maintenance" | "vision" | "energy" | "query";

export interface AiSampleResult {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  kind: AiSampleKind;
  execution: "local-sample";
  engine: string;
  inputFingerprint: string;
  startedAt: string;
  completedAt: string;
  input: unknown;
  output: unknown;
  metrics: Array<{ label: string; labelEn: string; value: string }>;
}
