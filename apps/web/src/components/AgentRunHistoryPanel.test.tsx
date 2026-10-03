import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AgentCrossProjectNotice,
  AgentRecoveryFailureNotice,
  AgentRunHistoryPanelView,
  mergeArchiveIntoEntries,
  type AgentRunHistoryRow,
} from "./AgentRunHistoryPanel";
import type { AgentRunArchiveView } from "../apiClients/industrialAgentApi";

const NOW = new Date("2026-10-02T10:00:00.000Z");
const FRESH = "2026-10-02T08:00:00.000Z";
const STALE = "2026-09-29T08:00:00.000Z";

function run(overrides: Partial<AgentRunHistoryRow> = {}): AgentRunHistoryRow {
  return { runId: "run-abc12345-rest", objective: "检查泵站风险", savedAt: FRESH, ...overrides };
}

function historyHtml(runs: AgentRunHistoryRow[], archiveError?: string): string {
  return renderToStaticMarkup(
    <AgentRunHistoryPanelView locale="zh-CN" runs={runs} now={NOW} {...(archiveError ? { archiveError } : {})} onOpen={vi.fn()} />,
  );
}

const archive: AgentRunArchiveView = {
  runId: "run-abc12345-rest",
  status: "failed",
  objective: "服务端目标",
  outcomeSummary: "工具失败",
  steps: 3,
  toolCalls: 1,
  toolIds: ["data.query.read"],
  endedAt: FRESH,
};

describe("AgentRunHistoryPanelView（H-C5-K13 历史运行）", () => {
  it("渲染本地记录：目标、runId 短码与打开入口；归档终态以语义色状态徽标显示", () => {
    const html = historyHtml([run()]);
    expect(html).toContain('aria-label="历史运行"');
    expect(html).toContain("检查泵站风险");
    expect(html).toContain("run-abc1…");
    expect(html).toContain("打开");
  });

  it("本地目标缺失时回填服务端归档目标并显示归档状态", () => {
    const rows = mergeArchiveIntoEntries([{ runId: archive.runId, objective: "", savedAt: FRESH }], { [archive.runId]: archive });
    const html = historyHtml(rows);
    expect(html).toContain("服务端目标");
    expect(html).toContain("运行失败");
  });

  it("无归档记录显示状态未知，不伪造终态", () => {
    expect(historyHtml([run()])).toContain("状态未知");
  });

  it("陈旧条目显式标注（dashed 边 + 陈旧徽标），新鲜条目不标", () => {
    const staleHtml = historyHtml([run({ savedAt: STALE })]);
    expect(staleHtml).toContain("陈旧");
    expect(staleHtml).toContain("stale");
    expect(historyHtml([run()])).not.toContain(">陈旧<");
  });

  it("空历史给可操作空态文案", () => {
    expect(historyHtml([])).toContain("还没有可恢复的运行记录");
  });

  it("服务端归档读取失败时明示降级来源，不静默", () => {
    const html = historyHtml([run()], "网关超时");
    expect(html).toContain("服务端归档读取失败");
    expect(html).toContain("网关超时");
  });
});

describe("AgentRecoveryFailureNotice（H-C5-K11 恢复失败显式可操作）", () => {
  function noticeHtml(notFound: boolean, message?: string, onClear?: () => void): string {
    return renderToStaticMarkup(
      <AgentRecoveryFailureNotice locale="zh-CN" runId="run-abc12345-rest" notFound={notFound}
        {...(message ? { message } : {})} {...(onClear ? { onClear } : {})} busy={false} onRetry={vi.fn()} onDismiss={vi.fn()} />,
    );
  }
  it("显示 runId 与重试入口；非 404 透出具体原因", () => {
    const html = noticeHtml(false, "服务返回空响应（HTTP 502）");
    expect(html).toContain('role="alert"');
    expect(html).toContain("run-abc1…");
    expect(html).toContain("恢复失败");
    expect(html).toContain("服务返回空响应（HTTP 502）");
    expect(html).toContain("重试恢复");
  });
  it("404 说明运行已不存在且不再提供重试，给可操作出路（清除记录按钮与文案一致）", () => {
    const html = noticeHtml(true, undefined, vi.fn());
    expect(html).toContain("已不存在");
    expect(html).not.toContain("重试恢复");
    expect(html).toContain("清除记录");
    expect(html).toContain("开始新任务");
  });
});

describe("AgentCrossProjectNotice（H-C5-K11 跨项目显式标注）", () => {
  it("说明所属项目与忽略行为，不静默丢弃", () => {
    const html = renderToStaticMarkup(
      <AgentCrossProjectNotice locale="zh-CN" runId="run-abc12345-rest" projectId="project-9" onDismiss={vi.fn()} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("属于其他项目（project-9）");
    expect(html).toContain("run-abc1…");
    expect(html).toContain("已忽略其更新");
  });
});
