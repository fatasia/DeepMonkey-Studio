import { AlertTriangle, CheckCircle2, Download, Eye } from "lucide-react";
import type { IndustrialValidationStudyRecord, VirtualDebugSuiteCaseResult, VirtualDebugSuiteResult } from "@bim-studio/contracts";

interface Props {
  result?: VirtualDebugSuiteResult | undefined;
  previousResult?: IndustrialValidationStudyRecord["latestResult"] | undefined;
  onInspect: (testCase: VirtualDebugSuiteCaseResult) => void;
  onExport: () => void;
}

/** 黄金矩阵只展示验收决策和可追溯入口，逐帧细节复用右侧单场景证据面板。 */
export function VirtualCommissioningSuiteEvidence({ result, previousResult, onInspect, onExport }: Props) {
  if (!result) {
    if (!previousResult?.scenarioId.endsWith("-golden-suite")) return null;
    return (
      <aside className={`commissioning-suite-summary ${previousResult.status}`}>
        <div>
          {previousResult.status === "passed" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>
            <strong>上次控制逻辑矩阵：{previousResult.status === "passed" ? "符合预期" : "存在不匹配"}</strong>
            <small>{new Date(previousResult.completedAt).toLocaleString()} · 指纹 {shortFingerprint(previousResult.evidenceFingerprint)}</small>
          </span>
        </div>
        <small>重新运行可查看每个用例的完整轨迹。</small>
      </aside>
    );
  }
  return (
    <section className={`commissioning-suite ${result.status}`}>
      <header>
        <div>
          {result.status === "passed" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>
            <strong>{result.status === "passed" ? "控制逻辑矩阵全部符合预期" : "控制逻辑矩阵存在结果偏差"}</strong>
            <small>{result.matchedCases}/{result.totalCases} 个用例符合预期 · 指纹 {shortFingerprint(result.evidenceFingerprint)}</small>
          </span>
        </div>
        <button type="button" onClick={onExport}><Download size={14} />导出矩阵证据</button>
      </header>
      <div className="commissioning-suite-cases">
        {result.cases.map((testCase) => (
          <article key={testCase.id} className={testCase.expectationMatched ? "matched" : "mismatch"}>
            {testCase.expectationMatched ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <span>
              <strong>{testCase.label}</strong>
              <small>预期 {statusLabel(testCase.expectedStatus)} · 实际 {statusLabel(testCase.result.status)}</small>
            </span>
            <button type="button" onClick={() => onInspect(testCase)}><Eye size={13} />查看轨迹</button>
          </article>
        ))}
      </div>
    </section>
  );
}

function statusLabel(status: "passed" | "failed"): string {
  return status === "passed" ? "通过" : "检出失败";
}

function shortFingerprint(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
