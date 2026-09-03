import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PprBopVersionDraft, PprOperation } from "@bim-studio/contracts";
import { parsePprQualitySpecification } from "./PprQualityControlEditor";
import { PprWorkInstructionEditor } from "./PprWorkInstructionEditor";
import { PprWorkInstructionPreview } from "./PprWorkInstructionPreview";

describe("PPR electronic work instruction UI", () => {
  it("parses common shop-floor specifications into structured quality evidence", () => {
    const check = instruction().qualityChecks[0]!;
    expect(parsePprQualitySpecification(check, "0.5–0.8 mm")).toMatchObject({
      specificationKind: "limits", lowerLimit: 0.5, upperLimit: 0.8, unit: "mm",
    });
    expect(parsePprQualitySpecification(check, "10 ± 0.2 N·m")).toMatchObject({
      specificationKind: "tolerance", targetValue: 10, tolerance: 0.2, unit: "N·m",
    });
    expect(parsePprQualitySpecification(check, "0.8–0.5 mm")).toBeUndefined();
  });

  it("keeps EWI optional and exposes structured authoring instead of a document-sized form", () => {
    const operation: PprOperation = {
      id: "assemble",
      name: "装配",
      standardTimeMinutes: 4,
      componentRefs: [{ componentId: "product", role: "in-process" }],
      references: [{ kind: "object", id: "fixture-01" }],
    };
    const emptyHtml = renderToStaticMarkup(<PprWorkInstructionEditor operation={operation} planReferences={[{ kind: "scene", id: "scene-1" }]} onChange={vi.fn()} />);
    expect(emptyHtml).toContain("电子作业指导书（EWI）");
    expect(emptyHtml).toContain("开始编制");
    expect(emptyHtml).toContain("可选");

    const authoredHtml = renderToStaticMarkup(<PprWorkInstructionEditor operation={{ ...operation, workInstruction: instruction() }} planReferences={[{ kind: "scene", id: "scene-1" }]} onChange={vi.fn()} />);
    expect(authoredHtml).toContain("操作步骤");
    expect(authoredHtml).toContain("安全注意");
    expect(authoredHtml).toContain("质量控制点");
    expect(authoredHtml).toContain("规格快捷输入");
    expect(authoredHtml).toContain("质量控制点 1 快捷规格");
    expect(authoredHtml).toContain("规格表达");
    expect(authoredHtml).toContain("检测方法");
    expect(authoredHtml).toContain("抽检频率");
    expect(authoredHtml).toContain("失控反应");
    expect(authoredHtml).toContain("复制质量控制点 1");
    expect(authoredHtml).toContain("不代表已经采集量测、执行 SPC");
    expect(authoredHtml).toContain("视觉上下文");
    expect(authoredHtml).toContain("fixture-01");
    expect(authoredHtml).not.toContain("负责人");
    expect(authoredHtml).not.toContain("审批");
  });

  it("renders result-side instructions in process order with real print and offline HTML actions", () => {
    const draft = plan();
    const html = renderToStaticMarkup(<PprWorkInstructionPreview
      draft={draft}
      operationOrder={["inspect", "assemble"]}
      documentLabel="v2 · 服务端分析"
    />);

    expect(html.indexOf("终检")).toBeLessThan(html.indexOf("装配"));
    expect(html).toContain("打印");
    expect(html).toContain("离线 HTML");
    expect(html).toContain("记录间隙测量值");
    expect(html).toContain("装配间隙");
    expect(html).toContain("每 10 件");
    expect(html).toContain("停止装配并隔离本批");
  });
});

function instruction() {
  return {
    steps: [{ id: "step-1", instruction: "沿定位销装入工件" }],
    safetyNotes: [{ id: "safety-1", note: "夹紧前双手离开夹具" }],
    qualityChecks: [{
      id: "quality-1",
      checkpoint: "装配间隙",
      specificationKind: "limits" as const,
      targetValue: 0.65,
      lowerLimit: 0.5,
      upperLimit: 0.8,
      unit: "mm",
      inspectionMethod: "塞尺",
      samplingFrequency: { mode: "every-n-items" as const, interval: 10 },
      outOfControlReaction: "停止装配并隔离本批",
    }],
    visualReferences: [{ kind: "object" as const, id: "fixture-01" }],
  };
}

function plan(): PprBopVersionDraft {
  return {
    planId: "assembly-plan",
    name: "总装计划",
    components: [{ id: "product", name: "整机", kind: "product" }],
    operations: [
      { id: "assemble", name: "装配", standardTimeMinutes: 4, componentRefs: [{ componentId: "product", role: "in-process" }], workInstruction: instruction() },
      {
        id: "inspect",
        name: "终检",
        standardTimeMinutes: 2,
        componentRefs: [{ componentId: "product", role: "output" }],
        workInstruction: {
          steps: [{ id: "inspect-step-1", instruction: "记录间隙测量值" }],
          safetyNotes: [],
          qualityChecks: [],
        },
      },
    ],
    precedenceRelations: [],
    resources: [],
    resourceAssignments: [],
  };
}
