import { useEffect, useState } from "react";
import { translate as tr, type AppLocale } from "../i18n";

/**
 * T6（审计 §二 2.3）：chat 长任务的进度聚合行——已耗时 + 当前阶段。
 * 与 agent 运行视图（进度% + 预算 metrics）对齐"同面板不出现两种时间观"的形态缺口：
 * chat 侧没有轮询预算，可如实给出的最小聚合就是耗时与阶段（等待响应/流式生成中），
 * 不伪造百分比。startedAt 缺省不渲染（历史消息不显示进度）。
 */
export function AiRequestProgress({ locale, startedAt, phase }: {
  locale: AppLocale;
  startedAt?: number;
  phase: "connecting" | "streaming";
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1_000));
  const elapsed = elapsedSeconds < 60
    ? `${elapsedSeconds}s`
    : `${Math.floor(elapsedSeconds / 60)}m${String(elapsedSeconds % 60).padStart(2, "0")}s`;
  return (
    <span className="ai-request-progress" role="timer" aria-live="off">
      {tr(locale, `已等待 ${elapsed}`, `Waited ${elapsed}`)}
      <span aria-hidden="true"> · </span>
      {phase === "streaming"
        ? tr(locale, "流式生成中", "Streaming response")
        : tr(locale, "等待服务响应", "Waiting for response")}
    </span>
  );
}
