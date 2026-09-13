import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Play, X } from "lucide-react";
import type { AiSampleKind, AiSampleResult } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import "./AiSampleRunner.css";
import { VisionSampleResult } from "./VisionSampleResult";
import { AiOperationalDraftReview } from "./AiOperationalDraftReview";
import { sampleSuggestionDraft } from "../ai/operationalSuggestionDraft";
import { QuerySampleResult } from "./QuerySampleResult";

const descriptions: Record<AiSampleKind, [string, string]> = {
  maintenance: ["内置温振数据与线性评分模型，仅作影子评估。", "Built-in temperature/vibration data and a linear scoring model; shadow evaluation only."],
  vision: ["使用内置 YOLOX-Nano 与示例图片，在本机执行真实识别并显示检测框。", "Run the bundled YOLOX-Nano model on a sample image locally and display detected boxes."],
  energy: ["用四个时段的合成数据验证能耗基线与偏差分析。", "Four synthetic periods validate the energy baseline and deviation analysis."],
  query: ["用四条合成温度记录运行正式查询内核，按设备计算平均值；查询计划随证据导出。", "Run the query engine on four synthetic temperature records; export the query plan with the evidence."],
};

/** 同一轻量入口覆盖准备、运行、结果和可导出的证据；切项目立即取消旧请求。 */
export function AiSampleRunner({ projectId, kind, locale = "zh-CN" }: { projectId: string; kind: AiSampleKind; locale?: AppLocale }) {
  const [result, setResult] = useState<AiSampleResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  useEffect(() => {
    setResult(undefined); setError(""); setBusy(false);
    return () => { request.current?.abort(); request.current = undefined; };
  }, [projectId, kind]);

  async function run() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new Error(t("样例运行超时，请检查服务后重试。", "Sample timed out. Check the service and retry."))), 30_000);
    setBusy(true); setResult(undefined); setError("");
    try {
      const next = await api.runAiSample(projectId, kind, controller.signal);
      if (request.current !== controller) return;
      if (next.projectId !== projectId || next.kind !== kind) throw new Error(t("返回结果与当前项目或样例不一致，请重试。", "The result does not match this project or sample. Retry."));
      setResult(next);
    } catch (reason) {
      if (request.current === controller) {
        const failure = controller.signal.aborted ? controller.signal.reason : reason;
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) { request.current = undefined; setBusy(false); }
    }
  }

  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `sample-${kind}-${result.runId}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return <section className="ai-sample-runner" aria-label={t("本地测试样例", "Local test sample")}>
    <div className="ai-sample-runner-toolbar">
      <button type="button" disabled={busy} onClick={() => void run()}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}
        {busy ? t("样例运行中", "Running sample") : t("一键运行样例", "Run sample")}
      </button>
      <span>{t(...descriptions[kind])}</span>
      {busy && <button type="button" onClick={() => { request.current?.abort(); request.current = undefined; setBusy(false); setError(t("已取消，可重新运行。", "Cancelled. You can run again.")); }}><X size={14} />{t("取消", "Cancel")}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {result && <div className="ai-sample-runner-result" aria-live="polite">
      <header><strong>{t("本地样例已完成", "Local sample completed")}</strong><button type="button" onClick={download}><Download size={13} />{t("下载运行证据", "Download evidence")}</button></header>
      <dl>{result.metrics.map(metric => <div key={metric.label}><dt>{t(metric.label, metric.labelEn)}</dt><dd>{metric.value}</dd></div>)}</dl>
      {kind === "vision" && <VisionSampleResult output={result.output} locale={locale} />}
      {kind === "query" ? <QuerySampleResult output={result.output} /> : <AiOperationalDraftReview draft={sampleSuggestionDraft(result)} locale={locale} />}
      <details><summary>{t("输入、结果与追溯", "Input, result and trace")}</summary><pre>{JSON.stringify(result, (key, value) => key === "dataUrl" ? "[image included in downloaded evidence]" : value, 2)}</pre></details>
    </div>}
  </section>;
}
