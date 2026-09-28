import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentMemoryRecord, AgentMemoryView } from "../apiClients/industrialAgentApi";
import { AiMemoryPanelView } from "./AiMemoryPanel";

const LOCALE = "zh-CN" as const;

const noop = () => undefined;
const noopAsync = async () => undefined;

function memoryRecord(overrides: Partial<AgentMemoryRecord> = {}): AgentMemoryRecord {
  return {
    id: "mem-1",
    content: "上轮被内核反驳的方案：利用率实测 0.42 高于预测阈值 0.2",
    status: "pending",
    origin: { kind: "agent-proposal", runId: "run-9ab12cd4", step: 3, proposalFingerprint: "0123456789abcdef" },
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    ...overrides,
  };
}

function view(overrides: Partial<AgentMemoryView> = {}): AgentMemoryView {
  return {
    rules: { configured: false, chars: 0, truncated: false },
    memories: [],
    ...overrides,
  };
}

describe("AiMemoryPanelView（H-C2 记忆面板，M0 族扩展；用户可感知硬要求）", () => {
  it("折叠行摘要：守则配置状态、待确认与生效计数齐备", () => {
    const html = renderToStaticMarkup(
      <AiMemoryPanelView
        locale={LOCALE}
        draft=""
        onDraft={noop}
        onEdit={noop}
        onCancelEdit={noop}
        onConfirmDelete={noop}
        onCancelDelete={noop}
        onAction={noopAsync}
        view={view({
          rules: { configured: true, chars: 120, truncated: false, excerpt: "# 守则" },
          memories: [memoryRecord(), memoryRecord({ id: "mem-2", status: "active", confirmedBy: "chief", confirmedAt: "2026-09-28T10:05:00.000Z" })],
        })}
      />,
    );
    expect(html).toContain("ai-context-disclosure ai-memory");
    expect(html).toContain("RULES.md 已配置（120 字符");
    expect(html).toContain("待确认 1");
    expect(html).toContain("生效 1");
  });

  it("条目行：来源徽标（守则/自动）、状态徽标、来源 run 可追溯、指纹 title 全文", () => {
    const html = renderToStaticMarkup(
      <AiMemoryPanelView
        locale={LOCALE}
        draft=""
        onDraft={noop}
        onEdit={noop}
        onCancelEdit={noop}
        onConfirmDelete={noop}
        onCancelDelete={noop}
        onAction={noopAsync}
        view={view({
          memories: [
            memoryRecord(),
            memoryRecord({ id: "mem-2", status: "active", confirmedBy: "chief", confirmedAt: "2026-09-28T10:05:00.000Z" }),
            memoryRecord({ id: "mem-3", status: "disabled" }),
          ],
        })}
      />,
    );
    expect(html).toContain("source-rules");
    expect(html).toContain("source-memory");
    expect(html).toContain("待确认");
    expect(html).toContain("生效中");
    expect(html).toContain("已停用");
    expect(html).toContain("run run-9ab1");
    expect(html).toContain('title="0123456789abcdef"');
    // 优先级表达以文字徽标呈现，不做第二套开关语义。
    expect(html).toContain("守则始终优先于记忆");
  });

  it("pending 条目呈现确认动作，active 呈现停用，disabled 呈现启用", () => {
    const html = renderToStaticMarkup(
      <AiMemoryPanelView
        locale={LOCALE}
        draft=""
        onDraft={noop}
        onEdit={noop}
        onCancelEdit={noop}
        onConfirmDelete={noop}
        onCancelDelete={noop}
        onAction={noopAsync}
        view={view({ memories: [
          memoryRecord(),
          memoryRecord({ id: "mem-2", status: "active", confirmedBy: "chief", confirmedAt: "2026-09-28T10:05:00.000Z" }),
          memoryRecord({ id: "mem-3", status: "disabled" }),
        ] })}
      />,
    );
    expect(html).toContain("确认生效");
    expect(html).toContain("停用");
    expect(html).toContain("启用");
    expect(html).toContain("删除");
  });

  it("编辑态与就地删除确认（footer 双键模式）", () => {
    const editing = renderToStaticMarkup(
      <AiMemoryPanelView
        locale={LOCALE}
        draft="修改中的内容"
        editingId="mem-1"
        onDraft={noop}
        onEdit={noop}
        onCancelEdit={noop}
        onConfirmDelete={noop}
        onCancelDelete={noop}
        onAction={noopAsync}
        view={view({ memories: [memoryRecord()] })}
      />,
    );
    expect(editing).toContain("修改中的内容");
    expect(editing).toContain("保存");
    const confirming = renderToStaticMarkup(
      <AiMemoryPanelView
        locale={LOCALE}
        draft=""
        confirmingId="mem-1"
        onDraft={noop}
        onEdit={noop}
        onCancelEdit={noop}
        onConfirmDelete={noop}
        onCancelDelete={noop}
        onAction={noopAsync}
        view={view({ memories: [memoryRecord()] })}
      />,
    );
    expect(confirming).toContain("确认删除");
    expect(confirming).toContain("取消");
  });

  it("未配置记忆时显示引导空态；守则未配置提示写文件路径", () => {
    const html = renderToStaticMarkup(
      <AiMemoryPanelView
        locale={LOCALE}
        draft=""
        onDraft={noop}
        onEdit={noop}
        onCancelEdit={noop}
        onConfirmDelete={noop}
        onCancelDelete={noop}
        onAction={noopAsync}
        view={view()}
      />,
    );
    expect(html).toContain("守则 未配置");
    expect(html).toContain("还没有自动记忆");
    expect(html).toContain("RULES.md");
    expect(html).not.toContain("ai-memory-item");
  });

  it("注入逐源审计说明在场；错误以 role=alert 呈现（诚实条款）", () => {
    const html = renderToStaticMarkup(
      <AiMemoryPanelView
        locale={LOCALE}
        draft=""
        error="服务不可用"
        onDraft={noop}
        onEdit={noop}
        onCancelEdit={noop}
        onConfirmDelete={noop}
        onCancelDelete={noop}
        onAction={noopAsync}
        view={view()}
      />,
    );
    expect(html).toContain("逐源审计");
    expect(html).toContain("读取失败");
    expect(html).toContain('role="alert"');
    expect(html).toContain("服务不可用");
  });
});
