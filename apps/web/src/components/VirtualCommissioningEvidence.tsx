import { AlertTriangle, CheckCircle2, Download, Focus, RotateCcw } from "lucide-react";
import type { VirtualDebugResult, VirtualDebugSignalBinding, VirtualDebugSignalValue } from "@bim-studio/contracts";
import type { CapabilityInvocationResult } from "../api";
import { virtualDebugFrameAt } from "./virtualCommissioningModel";

export function VirtualCommissioningEvidence({
  invocation,
  playheadMs,
  onPlayheadChange,
  onExport,
  onOpenTarget,
}: {
  invocation: CapabilityInvocationResult<VirtualDebugResult> | undefined;
  playheadMs: number;
  onPlayheadChange: (value: number) => void;
  onExport: () => void;
  onOpenTarget: (sceneId: string, objectId: string) => void;
}) {
  const result = invocation?.output;
  const frame = virtualDebugFrameAt(result, playheadMs);
  return (
    <section className="commissioning-evidence">
      {!result ? (
        <div className="commissioning-result-empty">
          <RotateCcw size={24} />
          <strong>等待运行</strong>
          <span>运行后在这里逐帧检查信号、故障、复位和断言结果。</span>
        </div>
      ) : (
        <>
          <header className={result.status}>
            <div>
              {result.status === "passed" ? <CheckCircle2 /> : <AlertTriangle />}
              <span>
                <strong>{result.status === "passed" ? "验收通过" : `${result.failures.length} 项验收失败`}</strong>
                <small>{result.trace.length} 帧 · {result.tickMs}ms 周期</small>
              </span>
            </div>
            <button onClick={onExport}>
              <Download size={14} />
              导出证据
            </button>
          </header>
          <div className="commissioning-fingerprint">
            <span>证据指纹</span>
            <code>{result.evidenceFingerprint}</code>
          </div>
          <div className="commissioning-timeline">
            <div>
              <strong>{frame?.atMs ?? 0} ms</strong>
              <span>{frame?.state === "faulted" ? "故障锁存" : frame?.state === "running" ? "设备运行" : "设备停止"}</span>
            </div>
            <input
              aria-label="回放时间"
              type="range"
              min="0"
              max={result.durationMs}
              step={result.tickMs}
              value={playheadMs}
              onChange={(event) => onPlayheadChange(Number(event.target.value))}
            />
          </div>
          <div className="commissioning-signal-grid">
            {result.bindings.map((binding) => (
              <SignalCard
                key={binding.id}
                binding={binding}
                value={frame?.signals[binding.signal]}
                onFocus={() => onOpenTarget(binding.target.sceneId, binding.target.objectId)}
              />
            ))}
          </div>
          <div className="commissioning-events">
            <strong>当前帧事件</strong>
            {frame?.events.length ? frame.events.map((event) => <span key={event}>{event}</span>) : <small>当前帧没有命令或故障事件</small>}
          </div>
          {result.failures.length > 0 && (
            <div className="commissioning-failures">
              <strong>失败定位</strong>
              {result.failures.map((failure) => (
                <article key={`${failure.assertionId}-${failure.atMs}`}>
                  <AlertTriangle size={14} />
                  <span>
                    <b>{failure.assertionId}</b>
                    <small>{failure.atMs}ms · {failure.message}</small>
                  </span>
                  {failure.target && (
                    <button onClick={() => onOpenTarget(failure.target!.sceneId, failure.target!.objectId)}>
                      <Focus size={13} />
                      定位设备
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SignalCard({
  binding,
  value,
  onFocus,
}: {
  binding: VirtualDebugSignalBinding;
  value: VirtualDebugSignalValue | undefined;
  onFocus: () => void;
}) {
  const state =
    binding.presentation === "alarm" && value === true
      ? "alarm"
      : binding.presentation === "running" && value === true
        ? "running"
        : "normal";
  return (
    <button className={state} onClick={onFocus}>
      <span>{binding.label ?? binding.signal}</span>
      <strong>{String(value ?? "—")}</strong>
      <small><Focus size={11} />定位到场景设备</small>
    </button>
  );
}
