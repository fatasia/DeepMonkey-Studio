import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SemanticModelEditor } from "./SemanticModelEditor";
import { SemanticFieldSelect } from "./SemanticEditorFields";
import { SemanticMetricList } from "./SemanticMetricList";
import { newSemanticModel } from "./semanticModelEditorLogic";

describe("semantic model editor", () => {
  it("keeps missing source fields visible and explicitly invalid", () => {
    const html = renderToStaticMarkup(<SemanticFieldSelect label="指标字段" value="missing" fields={[]} onChange={() => undefined} locale="zh-CN" />);
    expect(html).toContain('aria-invalid="true"'); expect(html).toContain("missing"); expect(html).toContain("已失效");
  });
  it("renders six aggregation choices and preserves field-free count", () => {
    const html = renderToStaticMarkup(<SemanticMetricList value={[{ id: "m", key: "count", label: "记录数", aggregation: "count" }]} fields={[]} onChange={() => undefined} locale="zh-CN" />);
    for (const value of ["count", "countDistinct", "sum", "avg", "min", "max"]) expect(html).toContain(`value="${value}"`);
    expect(html).toContain("此聚合允许不指定字段或表达式");
  });
  it("shows each save failure while keeping the draft name and submit boundary", () => {
    const draft = newSemanticModel("dataset"); draft.name = "保留这个草稿";
    const html = renderToStaticMarkup(<SemanticModelEditor value={draft} datasets={[]} pipelines={[]} projectId="p" locale="zh-CN" busy={false} errors={["指标字段无效", "参数链有环"]} onChange={() => undefined} onSave={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('value="保留这个草稿"'); expect(html).toContain("指标字段无效</li>"); expect(html).toContain("参数链有环</li>"); expect(html).toContain('type="submit"');
  });
});
