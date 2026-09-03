import type { ProjectRecord } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultLogistics, defaultPlantLite } from "./operationsPresentation";
import { LogisticsOperationsPanel } from "./OperationsScenarioPanels";
import type { PlantLiteRunProgress } from "./plantLiteRunController";

const project = { id: "project-1", name: "工厂项目" } as ProjectRecord;
const noop = () => undefined;

describe("LogisticsOperationsPanel", () => {
  it("presents three planning tasks in one compact switch", () => {
    const html = render("analytic");

    expect(html).toContain("快速估算");
    expect(html).toContain("流程仿真");
    expect(html).toContain("工艺规划");
    expect(html).toContain("运行快速估算");
  });

  it("opens process planning as its own task instead of a result-side card", () => {
    const html = render("ppr");

    expect(html).toContain("产品、工序和资源三步建立计划");
    expect(html).toContain("打开工作台");
    expect(html).not.toContain("运行快速估算");
  });

  it("keeps batch progress and cancellation next to the process simulation run action", () => {
    const progress: PlantLiteRunProgress = {
      kind: "batch",
      phase: "running",
      current: 2,
      total: 4,
      saved: 1,
    };
    const html = render("des", progress);

    expect(html).toContain("运行 2/4 · 已保存 1");
    expect(html).toContain("取消");
    expect(html).toContain("plant-lite-run-control");
  });
});

function render(mode: "analytic" | "des" | "ppr", plantRunProgress?: PlantLiteRunProgress) {
  return renderToStaticMarkup(<LogisticsOperationsPanel
    busy={false}
    logistics={defaultLogistics}
    plantLite={defaultPlantLite}
    mode={mode}
    snapshot={undefined}
    onChange={noop}
    onPlantLiteChange={noop}
    onModeChange={noop}
    onRun={noop}
    onRunPlantLite={noop}
    onRunPlantLiteSweep={noop}
    {...(plantRunProgress ? { plantRunProgress } : {})}
    onCancelPlantLite={noop}
    onReproduce={noop}
    onReproducePlantLite={noop}
    project={project}
    scenes={[]}
  />);
}
