import { CheckCircle2, Download, FileCheck2, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { VirtualDebugSignalBinding, VirtualDebugSignalValue } from "@bim-studio/contracts";
import {
  designVirtualCommissioningTests,
  type VirtualCommissioningTestDesignInput,
} from "./virtualCommissioningTestDesigner";

export function VirtualCommissioningTestDesignPanel({
  sceneId,
  bindings,
  durationMs,
  tickMs,
  speedSetpoint,
}: {
  sceneId: string;
  bindings: readonly VirtualDebugSignalBinding[];
  durationMs: number;
  tickMs: number;
  speedSetpoint: number;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const design = useMemo(
    () => designVirtualCommissioningTests(designInput(sceneId, bindings, durationMs, tickMs, speedSetpoint)),
    [bindings, durationMs, sceneId, speedSetpoint, tickMs],
  );
  const ready = design.drafts.filter((draft) => draft.readiness === "ready-for-review").length;
  const blockers = design.missingInformation.filter((item) => item.blocking);

  function downloadConfirmedDraft() {
    if (!confirmed || blockers.length > 0) return;
    const blob = new Blob([JSON.stringify({ confirmedAt: new Date().toISOString(), design }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${sceneId}-virtual-test-design.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <details className="commissioning-test-design">
      <summary>
        <span><FileCheck2 size={15} /><strong>测试设计助手</strong></span>
        <em>{ready}/{design.drafts.length} 可复核 · {blockers.length} 阻塞缺口</em>
      </summary>
      <div className="commissioning-test-design-body">
        <header>
          <div>
            <strong>正常、边界、故障、恢复测试草稿</strong>
            <small>草稿来自当前 I/O 映射；不会自动运行，也不会写入控制器。</small>
          </div>
          <code>{design.evidenceFingerprint.slice(-12)}</code>
        </header>
        {design.missingInformation.length > 0 && (
          <div className="commissioning-test-gaps">
            <strong><ShieldAlert size={14} />设计缺口</strong>
            {design.missingInformation.slice(0, 6).map((item) => (
              <p key={`${item.code}-${item.subjectId ?? "general"}`} className={item.blocking ? "blocking" : ""}>
                {item.message}
              </p>
            ))}
          </div>
        )}
        <div className="commissioning-test-drafts">
          {design.drafts.map((draft) => (
            <article key={draft.id} className={draft.readiness === "ready-for-review" ? "ready" : "incomplete"}>
              <span>{categoryLabel(draft.category)}</span>
              <strong>{draft.label}</strong>
              <small>{draft.steps.length} 步 · {draft.assertions.length} 断言 · {draft.coverageItems.length} 覆盖项</small>
              <em>{draft.readiness === "ready-for-review" ? "待人工确认" : "信息不完整"}</em>
            </article>
          ))}
        </div>
        <footer>
          <label>
            <input type="checkbox" checked={confirmed} disabled={blockers.length > 0} onChange={(event) => setConfirmed(event.target.checked)} />
            我已复核 I/O、互锁、边界和预期断言
          </label>
          <button type="button" disabled={!confirmed || blockers.length > 0} onClick={downloadConfirmedDraft}>
            {confirmed ? <CheckCircle2 size={14} /> : <Download size={14} />}
            导出已确认设计
          </button>
        </footer>
      </div>
    </details>
  );
}

function designInput(
  sceneId: string,
  bindings: readonly VirtualDebugSignalBinding[],
  durationMs: number,
  tickMs: number,
  speedSetpoint: number,
): VirtualCommissioningTestDesignInput {
  const signals = new Set(bindings.map((binding) => binding.signal));
  const expected = (values: Record<string, VirtualDebugSignalValue>) => Object.fromEntries(
    Object.entries(values).filter(([signal]) => signals.has(signal)),
  );
  const ioPoints = [...signals].sort().map((signal) => ({
    id: signal,
    name: bindings.find((binding) => binding.signal === signal)?.label ?? signal,
    direction: "bidirectional" as const,
    dataType: signal === "speedSetpoint" ? "number" as const : "boolean" as const,
    normalValue: signal === "speedSetpoint" ? speedSetpoint : false,
    safeValue: signal === "alarm" ? true : signal === "speedSetpoint" ? 0 : false,
    ...(signal === "speedSetpoint" ? { minimum: 0, maximum: Math.max(speedSetpoint * 1.2, 1) } : {}),
  }));
  const transitions = signals.has("motorRunning") ? [
    { id: "start", name: "启动", fromStateId: "idle", toStateId: "running", command: { type: "start" as const } },
    { id: "reset", name: "故障复位", fromStateId: "fault", toStateId: "idle", command: { type: "reset" as const } },
  ] : [];
  const interlocks = signals.has("alarm") ? [{
    id: "equipment-fault", name: "设备故障联锁", faultCode: "equipment-fault", alarmSignal: "alarm",
    affectedTransitionIds: transitions.filter((item) => item.id === "start").map((item) => item.id),
    safeSignals: expected({ motorRunning: false, alarm: true, speedSetpoint: 0 }),
  }] : [];
  return {
    suiteId: `${sceneId}-designed-suite`, durationMs, tickMs, ioPoints,
    states: [
      { id: "idle", name: "待机", initial: true, safe: true, expectedSignals: expected({ motorRunning: false, alarm: false, speedSetpoint: 0 }) },
      { id: "running", name: "运行", expectedSignals: expected({ motorRunning: true, alarm: false, speedSetpoint }) },
      { id: "fault", name: "故障", safe: true, expectedSignals: expected({ motorRunning: false, alarm: true, speedSetpoint: 0 }) },
    ],
    transitions,
    interlocks,
    safetyConstraints: [],
    bindings,
  };
}

function categoryLabel(category: "normal" | "boundary" | "fault" | "recovery"): string {
  return ({ normal: "正常", boundary: "边界", fault: "故障", recovery: "恢复" })[category];
}
