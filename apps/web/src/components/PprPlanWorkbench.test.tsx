import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { analyzePprPlanDraft } from "./pprPlanDraftModel";
import { PprPlanDetails } from "./PprPlanDetails";
import { PprPlanEditor } from "./PprPlanEditor";
import { PprPlanInsights } from "./PprPlanInsights";

vi.mock("../api", () => ({ api: {} }));

describe("PD Lite authoring workbench", () => {
  it("presents the first-run path as three plain-language steps", () => {
    const html = renderToStaticMarkup(<PprPlanDetails projectId="project-1" references={{ sceneId: "scene-1" }} onClose={vi.fn()} onCreatePlantLiteDraft={vi.fn()} />);
    expect(html).toContain("产品结构");
    expect(html).toContain("工序安排");
    expect(html).toContain("资源配置");
    expect(html).toContain("保存为新版本");
    expect(html).toContain("版本影响");
    expect(html).toContain("变体与高级上下文");
    expect(html).toContain("适用条件表达式");
    expect(html).toContain("Lite 引擎不执行条件表达式");
    expect(html).toContain("先添加至少一个产品");
    expect(html).toContain("请先明确填写正数目标节拍");
    expect(html).toContain("继续做流程仿真");
    expect(html).not.toContain("默认模板");
    expect(html).not.toContain("JSON");
  });

  it("renders structured controls for all three authoring views without a JSON textarea", () => {
    const draft = fixtureDraft();
    const views = (["product", "operations", "resources"] as const).map((section) =>
      renderToStaticMarkup(<PprPlanEditor section={section} draft={draft} onChange={vi.fn()} />));

    expect(views[0]).toContain("上级");
    expect(views[1]).toContain("标准工时（分钟）");
    expect(views[1]).toContain("物料角色");
    expect(views[1]).toContain("电子作业指导书（EWI）");
    expect(views[1]).toContain("质量控制点");
    expect(views[1]).toContain("缺质量定义");
    expect(views[1]).toContain("0/1 已完整");
    expect(views[1]).toContain("高级：工序依赖");
    expect(views[1]).toContain("条件前置关系");
    expect(views[1]).toContain("关系适用条件表达式");
    expect(views[1]).toContain("variant == &#x27;EU&#x27;");
    expect(views[2]).toContain("并行能力");
    expect(views[2]).toContain("工序使用资源");
    expect(views.join("")).toContain("适用变体 ID");
    expect(views.join("")).toContain("适用条件表达式");
    expect(views[1]).toContain("<textarea");
    expect(views.join("")).not.toContain("JSON");
  });

  it("shows validation, schedule, resource conflicts and arbitrary version selectors", () => {
    const draft = fixtureDraft();
    const analysis = analyzePprPlanDraft(draft);
    const html = renderToStaticMarkup(<PprPlanInsights
      instructionPlan={draft}
      plantDraft={draft}
      versions={[
        { ...draft, id: "v1-id", version: "v1", createdAt: "2026-09-03T08:00:00.000Z" },
        { ...draft, id: "v2-id", version: "v2", createdAt: "2026-09-03T09:00:00.000Z", basedOnVersionId: "v1-id" },
      ]}
      analysis={analysis}
      analysisLabel="草稿实时分析"
      validationErrorCount={0}
      variantIds={["EU", "US"]}
      activeVariantId="EU"
      comparison={undefined}
      beforeVersionId="v1-id"
      afterVersionId="v2-id"
      busy={false}
      onActiveVariantChange={vi.fn()}
      onBeforeChange={vi.fn()}
      onAfterChange={vi.fn()}
      onCompare={vi.fn()}
      onCreatePlantLiteDraft={vi.fn()}
    />);

    expect(html).toContain("关键路径");
    expect(html).toContain("排程预览");
    expect(html).toContain("资源冲突");
    expect(html).toContain("质量控制覆盖");
    expect(html).toContain("质量待完善");
    expect(html).toContain("定义级证据；不代表量测采集、SPC");
    expect(html).toContain("分析变体");
    expect(html).toContain("道工序生效");
    expect(html).toContain("产线平衡");
    expect(html).toContain("目标节拍 6 分/件");
    expect(html).toContain("电子作业指导书");
    expect(html).toContain("离线 HTML");
    expect(html).toContain("基线");
    expect(html).toContain("目标");
    expect(html).toContain("比较影响");
    expect(html).toContain("生成仿真草稿");
    expect(html).toContain("不会自动运行");
  });
});

function fixtureDraft(): PprBopVersionDraft {
  return {
    planId: "pd-lite-project-1",
    name: "总装计划",
    targetTaktMinutes: 6,
    references: [{ kind: "scene", id: "scene-1" }, { kind: "study", id: "study-1" }],
    components: [
      { id: "product-1", name: "整机", kind: "product" },
      { id: "part-1", name: "底座", kind: "part", parentComponentId: "product-1" },
    ],
    operations: [
      {
        id: "operation-1",
        name: "定位",
        standardTimeMinutes: 3,
        componentRefs: [{ componentId: "part-1", role: "in-process", quantity: 1 }],
        workInstruction: {
          steps: [{ id: "position-step-1", instruction: "将底座放入定位夹具" }],
          safetyNotes: [{ id: "position-safety-1", note: "夹紧前确认手部离开夹具" }],
          qualityChecks: [{ id: "position-quality-1", checkpoint: "定位状态", acceptanceCriteria: "定位销完全入位" }],
          visualReferences: [{ kind: "scene", id: "scene-1" }],
        },
      },
      { id: "operation-2", name: "装配", standardTimeMinutes: 5, componentRefs: [{ componentId: "product-1", role: "output", quantity: 1 }] },
    ],
    precedenceRelations: [{
      id: "relation-1",
      predecessorOperationId: "operation-1",
      successorOperationId: "operation-2",
      condition: { expression: "variant == 'EU'", description: "欧盟版本采用该前置关系" },
    }],
    resources: [{ id: "resource-1", name: "装配工位", kind: "station", capacity: 1 }],
    resourceAssignments: [
      { id: "assignment-1", operationId: "operation-1", resourceId: "resource-1", requiredCapacity: 1 },
      { id: "assignment-2", operationId: "operation-2", resourceId: "resource-1", requiredCapacity: 1 },
    ],
  };
}
