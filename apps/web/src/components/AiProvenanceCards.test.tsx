import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  aiHypothesisProposalFingerprint,
  type AiHypothesisContract,
  type AiVerificationEnvelope,
} from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { AiHypothesisVerdictCard } from "./AiHypothesisVerdictCard";
import { AiProvenanceChainView, AiProvenanceTracePanel, formatAiTimestamp } from "./AiProvenanceTraceView";
import { AiProvenancePanelView } from "./AiProvenancePanel";
import type { ProvenanceChainList } from "../apiClients/provenanceApi";
import {
  buildAiProvenanceHypothesisNode,
  buildAiProvenanceKernelRunNode,
  buildAiProvenanceVerdictNode,
  type AiProvenanceChain,
} from "@bim-studio/contracts";

const LOCALE: AppLocale = "zh-CN";

const HYPOTHESIS: AiHypothesisContract = {
  hypothesisVersion: "1",
  id: "hyp-ui-1",
  statement: "校准场景中传感器单元利用率低于 0.3",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
};

const ENVELOPE: AiVerificationEnvelope = {
  proposalFingerprint: aiHypothesisProposalFingerprint(HYPOTHESIS),
  inputFingerprint: "123456789abcdef0",
  resultFingerprint: "23456789abcdef01",
  verdict: "confirmed",
  tolerance: { absolute: 0.05 },
  reasonCode: "prediction-within-tolerance",
  rationale: "假设「传感器利用率低于 0.3」：实测 sensor-unit=0.095238，低于阈值，越过容差带；golden 基准对照一致。",
  observed: { metric: "resource-utilization", resourceId: "sensor-unit", value: 0.095238 },
  engineId: "plant-lite-des",
  goldenHash: "cf20cfbd6e97a617",
  goldenMatch: true,
  generatedAt: "2026-09-28T10:00:00.000Z",
  evidence: [],
};

function intactChain(): AiProvenanceChain {
  const hypothesis = buildAiProvenanceHypothesisNode(HYPOTHESIS, ENVELOPE.proposalFingerprint, "2026-09-28T09:59:00.000Z");
  const run = buildAiProvenanceKernelRunNode(ENVELOPE, { seed: "t23-calibration-2026-09-27", replications: 12, executedAt: "2026-09-28T10:00:00.000Z" });
  const verdict = buildAiProvenanceVerdictNode(ENVELOPE, "2026-09-28T10:00:01.000Z");
  return {
    hypothesis,
    runs: [run],
    verdicts: [verdict],
    reports: [],
    edges: [
      { from: ENVELOPE.proposalFingerprint, to: ENVELOPE.resultFingerprint, relation: "executed" },
      { from: ENVELOPE.resultFingerprint, to: `verdict:${ENVELOPE.resultFingerprint}`, relation: "judged" },
    ],
    integrity: "intact",
    breaks: [],
  };
}

/** H-C3 档案视图渲染断言（静态渲染口径；浏览器视觉闭环工具缺失，报告如实声明）。 */
describe("H-C3 档案视图（AiProvenanceTraceView / AiProvenancePanel）", () => {
  it("结论卡片动作位：传 projectId 出现『查看档案』按钮（默认收起）；未传 projectId 不出现（H-C1 行为不变）", () => {
    const withArchive = renderToStaticMarkup(<AiHypothesisVerdictCard locale={LOCALE} envelope={ENVELOPE} projectId="project-1" />);
    expect(withArchive).toContain("ai-card-action");
    expect(withArchive).toContain("查看档案");
    expect(withArchive).toContain('aria-expanded="false"');

    const withoutArchive = renderToStaticMarkup(<AiHypothesisVerdictCard locale={LOCALE} envelope={ENVELOPE} />);
    expect(withoutArchive).not.toContain("查看档案");
    expect(withoutArchive).not.toContain("ai-card-action");
  });

  it("三跳时间轴：假设→内核运行→判定 三段齐备，指纹/种子/判定徽标可见，完整链无断裂警示", () => {
    const html = renderToStaticMarkup(<AiProvenanceChainView locale={LOCALE} chain={intactChain()} />);
    expect(html).toContain("假设");
    expect(html).toContain("内核运行");
    expect(html).toContain("判定");
    expect(html).toContain("已证实");
    expect(html).toContain("seed t23-calibration");
    expect(html).toContain("golden cf20…");
    expect(html).toContain("resource-utilization:sensor-unit");
    expect(html).toContain("1234…");
    expect(html).toContain("2345…");
    expect(html).not.toContain("链断裂");
    // 三重编码：判定节点色类 + 图标 + 文字
    expect(html).toContain("dot-verdict verdict-confirmed");
    expect(html).toContain("lucide-circle-check");
  });

  it("断链：完整性破坏如实呈现『链断裂』与理由，不静默", () => {
    const chain = intactChain();
    const verdict = chain.verdicts[0]!;
    chain.verdicts = [{ ...verdict, verdict: "refuted" }];
    chain.integrity = "broken";
    chain.breaks = [{ nodeId: verdict.nodeId, code: "verdict-integrity-mismatch", detail: "判定完整性指纹与读回重算不一致" }];
    const html = renderToStaticMarkup(<AiProvenanceChainView locale={LOCALE} chain={chain} />);
    expect(html).toContain("链断裂");
    expect(html).toContain("verdict-integrity-mismatch");
    expect(html).toContain("lucide-unlink");
  });

  it("登记未验证：空运行段如实呈现，不伪造运行节点", () => {
    const chain = { ...intactChain(), runs: [], verdicts: [] };
    const html = renderToStaticMarkup(<AiProvenanceChainView locale={LOCALE} chain={chain} />);
    expect(html).toContain("从未执行验证");
    expect(html).not.toContain("seed");
  });

  it("档案面板：列表行含链数摘要/判定徽标/查看三跳链按钮；断链行有警示徽标", () => {
    const view: ProvenanceChainList = {
      chains: [{
        hypothesis: intactChain().hypothesis,
        runCount: 2,
        reportCount: 0,
        latest: { verdict: "confirmed", reasonCode: "prediction-within-tolerance", judgedAt: "2026-09-28T10:00:01.000Z" },
        integrity: "intact",
        lastActivityAt: "2026-09-28T10:00:01.000Z",
      }],
      integrity: { intact: true, brokenNodes: [] },
    };
    const html = renderToStaticMarkup(<AiProvenancePanelView locale={LOCALE} projectId="project-1" view={view} onToggle={() => {}} onRefresh={() => {}} />);
    expect(html).toContain("实验档案");
    expect(html).toContain("已归档 1 条链");
    expect(html).toContain("2 次运行");
    expect(html).toContain("已证实");
    expect(html).toContain("查看三跳链");
    expect(html).not.toContain("断链");

    const row = view.chains[0]!;
    const brokenView: ProvenanceChainList = {
      chains: [{
        hypothesis: row.hypothesis,
        runCount: row.runCount,
        reportCount: row.reportCount,
        ...(row.latest ? { latest: row.latest } : {}),
        integrity: "broken",
        lastActivityAt: row.lastActivityAt,
      }],
      integrity: { intact: false, brokenNodes: ["verdict:23456789abcdef01"] },
    };
    const brokenHtml = renderToStaticMarkup(<AiProvenancePanelView locale={LOCALE} projectId="project-1" view={brokenView} onToggle={() => {}} onRefresh={() => {}} />);
    expect(brokenHtml).toContain("断链");
    expect(brokenHtml).toContain("integrity-broken");
  });

  it("档案容器静态渲染进入读取态（SSR 不执行取数），取数失败/未命中分支由纯视图与运行时覆盖", () => {
    const html = renderToStaticMarkup(<AiProvenanceTracePanel locale={LOCALE} projectId="project-1" resultFingerprint={ENVELOPE.resultFingerprint} />);
    expect(html).toContain("正在读取实验档案");
    expect(html).toContain('role="status"');
  });

  // ── T12 回归（审计 §二 2.5：档案列表用 UTC slice、时间轴用本地时区，同一链两处时间不同）──
  it("T12: formatAiTimestamp renders local MM-DD HH:mm without the year, and is invalid-input honest", () => {
    const expected = (() => {
      const date = new Date("2026-09-28T10:00:01.000Z");
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    })();
    expect(formatAiTimestamp("2026-09-28T10:00:01.000Z")).toBe(expected);
    // 解析失败原样返回（不伪造时间）。
    expect(formatAiTimestamp("not-a-date")).toBe("not-a-date");
    // 口径形状锁死：本地两位月-日 时:分，无年份、无 T 分隔、无秒。
    expect(expected).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("T12: the chain list shows the same shared local timestamp instead of the raw UTC slice", () => {
    const view: ProvenanceChainList = {
      chains: [{
        hypothesis: intactChain().hypothesis,
        runCount: 1,
        reportCount: 0,
        latest: { verdict: "confirmed", reasonCode: "prediction-within-tolerance", judgedAt: "2026-09-28T10:00:01.000Z" },
        integrity: "intact",
        lastActivityAt: "2026-09-28T10:00:01.000Z",
      }],
      integrity: { intact: true, brokenNodes: [] },
    };
    const html = renderToStaticMarkup(<AiProvenancePanelView locale={LOCALE} projectId="project-1" view={view} onToggle={() => {}} onRefresh={() => {}} />);
    // 旧口径是 UTC 串前 16 位（含年份，如 2026-09-28 10:00）——统一后不再出现年份形态。
    expect(html).not.toContain("2026-09-28");
    expect(html).toContain(formatAiTimestamp("2026-09-28T10:00:01.000Z"));
  });

  // ── T10 回归（审计 §二 2.4：三证体系空态只有循环指引，不说在哪运行、无样例目标）──
  it("T10: the empty archive renders the first-use guide with a copyable sample goal and an agent entry", () => {
    const empty: ProvenanceChainList = { chains: [], integrity: { intact: true, brokenNodes: [] } };
    const html = renderToStaticMarkup(
      <AiProvenancePanelView locale={LOCALE} projectId="project-1" view={empty} onToggle={() => {}} onRefresh={() => { }}
        onOpenAgent={() => {}} />,
    );
    expect(html).toContain("ai-firstuse-guide");
    expect(html).toContain("执行任务");
    expect(html).toContain("示例目标：把水泵转速提高 10%");
    expect(html).toContain('aria-label="复制示例目标"');
    expect(html).toContain("去「执行任务」运行一次假设验证");
    // 有档案时引导块退场（不常驻刷屏）。
    const nonEmpty: ProvenanceChainList = {
      chains: [{
        hypothesis: intactChain().hypothesis,
        runCount: 1,
        reportCount: 0,
        latest: { verdict: "confirmed", reasonCode: "prediction-within-tolerance", judgedAt: "2026-09-28T10:00:01.000Z" },
        integrity: "intact",
        lastActivityAt: "2026-09-28T10:00:01.000Z",
      }],
      integrity: { intact: true, brokenNodes: [] },
    };
    const nonEmptyHtml = renderToStaticMarkup(
      <AiProvenancePanelView locale={LOCALE} projectId="project-1" view={nonEmpty} onToggle={() => {}} onRefresh={() => { }}
        onOpenAgent={() => {}} />,
    );
    expect(nonEmptyHtml).not.toContain("ai-firstuse-guide");
  });
});
