import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, LoaderCircle } from "lucide-react";
import type { AiDataBindingRunRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { formatAiTimestamp } from "./AiProvenanceTraceView";

export function AiDataRunHistory({ projectId, bindingId }: { projectId: string; bindingId?: string }) {
  const [runs, setRuns] = useState<AiDataBindingRunRecord[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!bindingId) {
      setRuns([]);
      return;
    }
    let disposed = false;
    const load = () => api.listAiDataBindingRuns(projectId, { bindingId, limit: 5 })
      .then((records) => { if (!disposed) { setRuns(records); setError(""); } })
      .catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [bindingId, projectId]);

  if (!bindingId) return null;
  return (
    <section className="ai-run-history">
      <header><span>最近运行</span><small>自动刷新 · 保留来源与绑定版本</small></header>
      {error ? <p><AlertTriangle size={13} />{error}</p> : runs.length === 0 ? (
        <p><Clock3 size={13} />尚无运行记录，首次执行后在这里追溯。</p>
      ) : runs.map((run) => (
        <article key={run.id} className={run.status}>
          <i>{run.status === "succeeded" ? <CheckCircle2 size={13} /> : run.status === "running" ? <LoaderCircle className="spin" size={13} /> : <AlertTriangle size={13} />}</i>
          <span>
            <strong>{statusLabel(run.status)}</strong>
            <small>{run.output?.summary ?? run.failure?.message ?? `绑定 v${run.bindingRevision}`}</small>
          </span>
          <time>{formatAiTimestamp(run.completedAt ?? run.startedAt ?? run.createdAt)}{run.durationMs !== undefined ? ` · ${run.durationMs}ms` : ""}</time>
        </article>
      ))}
    </section>
  );
}

function statusLabel(status: AiDataBindingRunRecord["status"]): string {
  return ({ queued: "等待运行", running: "正在运行", succeeded: "运行成功", failed: "运行失败", skipped: "已跳过", cancelled: "已取消" })[status];
}
