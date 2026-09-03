import { describe, expect, it } from "vitest";
import {
  assessOnlineFlowVisualEvidence,
  ONLINE_FLOW_VISUAL_POLICY,
  ONLINE_FLOW_VISUAL_SELECTORS,
} from "./onlineFlowVisualQuality.mjs";

describe("online-flow visual quality policy", () => {
  it("sets a 12px business baseline while keeping a named 10px technical exception", () => {
    expect(ONLINE_FLOW_VISUAL_POLICY).toMatchObject({
      businessTextMinimumPx: 12,
      technicalTextMinimumPx: 10,
      targetMinimumPx: 28,
      targetRecommendedPx: 32,
    });
    expect(ONLINE_FLOW_VISUAL_SELECTORS.technicalText).toContain(".dashboard-ruler");
    expect(ONLINE_FLOW_VISUAL_SELECTORS.technicalText).toContain(".monaco-editor");
    expect(ONLINE_FLOW_VISUAL_SELECTORS.technicalText).toContain("-thumbnail");
    expect(ONLINE_FLOW_VISUAL_SELECTORS.technicalText).toContain("-meta");
    expect(ONLINE_FLOW_VISUAL_SELECTORS.topbar).toContain(".behavior-panel-actions");
  });

  it("blocks sub-28px targets but keeps 28-31px targets as a 32px advisory", () => {
    const failed = assessOnlineFlowVisualEvidence(evidence({ smallTargetCount: 1 }), "editor");
    expect(failed.failures).toContain("editor 存在 1 个小于 28px 的主要点击目标");

    const advised = assessOnlineFlowVisualEvidence(evidence({ belowRecommendedTargetCount: 2 }), "editor");
    expect(advised.failures).toEqual([]);
    expect(advised.advisories).toContain("editor 有 2 个点击目标低于推荐的 32px");
  });

  it("blocks topbar wrapping, clipping or overlap evidence", () => {
    expect(assessOnlineFlowVisualEvidence(evidence({ topbarIssueCount: 1 }), "workspace").failures).toEqual([
      "workspace 顶栏存在换行、裁切或区域重叠",
    ]);
  });

  it("blocks inaccessible icons and controls whose labels collapse into vertical text", () => {
    const result = assessOnlineFlowVisualEvidence(evidence({
      inaccessibleIconControlCount: 2,
      iconControlWithoutTooltipCount: 2,
      compressedTextControlCount: 1,
    }), "script");
    expect(result.failures).toContain("script 存在 2 个缺少可访问名称的纯图标控件");
    expect(result.failures).toContain("script 存在 2 个缺少悬停提示的纯图标控件");
    expect(result.failures).toContain("script 存在 1 个文字被挤成竖排的控件");
  });

  it("does not turn explicit technical exemptions or absent hidden/icon text into failures", () => {
    const result = assessOnlineFlowVisualEvidence(evidence({
      technicalTextExemptionCount: 3,
      technicalTextExemptions: [{ identity: "span.asset-meta[12 个对象]", fontSize: 10, minimum: 10, technical: true }],
    }), "assets");
    expect(result).toEqual({ failures: [], advisories: [] });
  });
});

function evidence(patch = {}) {
  return {
    smallTextCount: 0,
    smallText: [],
    technicalTextExemptionCount: 0,
    technicalTextExemptions: [],
    smallTargetCount: 0,
    smallTargets: [],
    belowRecommendedTargetCount: 0,
    belowRecommendedTargets: [],
    inaccessibleIconControlCount: 0,
    inaccessibleIconControls: [],
    iconControlWithoutTooltipCount: 0,
    iconControlsWithoutTooltip: [],
    compressedTextControlCount: 0,
    compressedTextControls: [],
    topbarIssueCount: 0,
    topbarIssues: [],
    ...patch,
  };
}
