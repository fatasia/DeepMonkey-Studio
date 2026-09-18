import { summarizeScenePublicationCompatibility, type ScenePublicationCompatibilityReport } from "@bim-studio/contracts";

type CompatibilityErrorCode = "publication-compatibility-blocked" | "publication-confirmation-required";

export class ScenePublicationCompatibilityError extends Error {
  readonly report: ScenePublicationCompatibilityReport;
  constructor(message: string, readonly code: CompatibilityErrorCode, report: ScenePublicationCompatibilityReport) {
    super(message); this.name = "ScenePublicationCompatibilityError";
    const copy = structuredClone(report);
    for (const item of copy.items) { Object.freeze(item.evidenceIds); Object.freeze(item); }
    for (const proof of copy.evidence) Object.freeze(proof);
    Object.freeze(copy.items); Object.freeze(copy.evidence);
    this.report = Object.freeze(copy);
  }
}

/** 只消费内部可信检查器结果；不验证证据来源或替代检查器的场景覆盖审计。 */
export function assertScenePublicationDeliverable(report: ScenePublicationCompatibilityReport): void {
  let verified: ScenePublicationCompatibilityReport;
  try {
    if (report.schemaVersion !== 1 || !["ready", "blocked", "confirmation-required"].includes(report.status)) {
      throw new Error("发布兼容报告版本或汇总状态无效。");
    }
    // 报告不携带原能力配置表；能力名称由可信检查器负责，现有合同重验上下文和证据绑定。
    verified = summarizeScenePublicationCompatibility({ ...report,
      profile: { version: report.capabilityProfileVersion, capabilities: [...new Set(report.items.map(item => item.capability))] },
    });
  } catch (reason) {
    throw new ScenePublicationCompatibilityError(`无法交付：${reason instanceof Error ? reason.message : String(reason)}`,
      "publication-compatibility-blocked", report);
  }
  if (report.status === "ready" && verified.status === "ready") return;
  const blocked = report.status === "blocked" || verified.status === "blocked";
  const issues = verified.items.filter(item => item.status === "blocked" || item.status === "degraded"
    || (item.status === "webview-only" && verified.target === "deep-native"));
  const summary = blocked ? "发布兼容检查未通过，客户端无法交付。"
    : "发布包含降级项，需审核降级方案后重新检查；当前流程不接受跳过确认。";
  const details = issues.slice(0, 8).map(item =>
    `对象 ${compact(item.objectId, 120)} · ${compact(item.path, 200)}：${compact(item.reason, 480)}；处理：${compact(item.remediation, 320)}`);
  if (issues.length > 8) details.push(`另有 ${issues.length - 8} 项未通过；处理以上问题后重新检查。`);
  if (!issues.length) details.push("报告汇总状态尚未通过，请重新运行兼容检查。");
  throw new ScenePublicationCompatibilityError([summary, ...details].join("\n"),
    blocked ? "publication-compatibility-blocked" : "publication-confirmation-required",
    { ...verified, status: blocked ? "blocked" : "confirmation-required" });
}

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
