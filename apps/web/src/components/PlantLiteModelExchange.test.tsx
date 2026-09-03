import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { PlantLiteModelExchange, PlantLiteModelImportReview } from "./PlantLiteModelExchange";
import { createDefaultPlantLiteRequest } from "./plantLiteModelEditing";

const noop = () => undefined;

describe("PlantLiteModelExchange", () => {
  it("keeps model exchange behind progressive disclosure and explains its scope", () => {
    const request = createDefaultPlantLiteRequest();
    const html = renderToStaticMarkup(<PlantLiteModelExchange
      value={request}
      model={request.model!}
      onChange={noop}
    />);

    expect(html).toContain("模型文件");
    expect(html).toContain("按需展开");
    expect(html).toContain("导出模型");
    expect(html).toContain("选择 JSON");
    expect(html).toContain("不会带入 Study 名称、运行条件、结果或凭据");
    expect(html).not.toContain("确认替换");
  });

  it("shows file identity, model counts and an explicit confirm step only after validation", () => {
    const model = createAgvLinePlantLiteModel({ agvCount: 4 });
    const html = renderToStaticMarkup(<PlantLiteModelImportReview
      state={{
        status: "ready",
        preview: {
          fileName: "factory-a.plant-lite.json",
          sourceApplication: "Industrial Studio",
          model,
          nodeCount: model.nodes.length,
          resourceCount: 1,
          resourceUnitCount: 4,
        },
      }}
      onCancel={noop}
      onConfirm={noop}
      onRetry={noop}
    />);

    expect(html).toContain("factory-a.plant-lite.json");
    expect(html).toContain(`${model.nodes.length} 个节点`);
    expect(html).toContain("1 项资源 / 4 个资源单元");
    expect(html).toContain("校验通过，确认后只替换当前模型");
    expect(html).toContain("取消");
    expect(html).toContain("确认替换");
  });

  it("keeps invalid imports recoverable without exposing the replace action", () => {
    const html = renderToStaticMarkup(<PlantLiteModelImportReview
      state={{ status: "invalid", fileName: "broken.json", issues: ["$.nodes：必须包含至少一个节点", "缺少模型单位声明"] }}
      onCancel={noop}
      onConfirm={noop}
      onRetry={noop}
    />);

    expect(html).toContain("不能导入 · broken.json");
    expect(html).toContain("$.nodes：必须包含至少一个节点");
    expect(html).toContain("缺少模型单位声明");
    expect(html).toContain("重新选择");
    expect(html).toContain("取消");
    expect(html).not.toContain("确认替换");
  });

  it("allows a pending read to be cancelled", () => {
    const html = renderToStaticMarkup(<PlantLiteModelImportReview
      state={{ status: "reading", fileName: "large-line.json" }}
      onCancel={noop}
      onConfirm={noop}
      onRetry={noop}
    />);

    expect(html).toContain("正在检查模型");
    expect(html).toContain("large-line.json");
    expect(html).toContain("取消");
    expect(html).not.toContain("确认替换");
  });
});
