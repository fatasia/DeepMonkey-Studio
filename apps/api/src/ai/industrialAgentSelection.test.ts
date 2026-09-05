import { describe, expect, it } from "vitest";
import { selectedAgentDatasets, validateAgentDatasetSelection } from "./industrialAgentSelection.js";

const catalog = { projectId: "p", total: 2, truncated: false, datasets: ["a", "b"].map(id => ({ id, name: `源 ${id}`, fields: [{ key: "v", label: "值", type: "number" as const }], fieldsTruncated: false, updatedAt: "2026-09-05" })) };
const decision = { kind: "request-input", rationale: "有歧义", question: "请选择", options: [{ id: "a", label: "假的名称" }, { id: "b", label: "假的名称" }] };

describe("server-owned Agent choices", () => {
  it("uses server names and field descriptions, rejecting foreign and duplicate IDs", () => {
    expect(validateAgentDatasetSelection(decision, catalog)).toMatchObject({ options: [{ id: "a", label: "源 a", description: "值" }, { id: "b", label: "源 b" }] });
    expect(() => validateAgentDatasetSelection({ ...decision, options: [...decision.options, { id: "foreign", label: "外部" }] }, catalog)).toThrow("目录以外");
    expect(() => validateAgentDatasetSelection({ ...decision, options: [decision.options[0], decision.options[0]] }, catalog)).toThrow("重复");
  });
  it("revalidates the latest selection against the current catalog", () => {
    const checkpoint = { selections: [{ option: { id: "b", label: "旧名" }, selectedBy: "operator", selectedAt: "now" }] } as never;
    expect(selectedAgentDatasets(checkpoint, catalog)).toMatchObject([{ id: "b", name: "源 b" }]);
    expect(() => selectedAgentDatasets(checkpoint, { ...catalog, datasets: [] })).toThrow("已删除");
  });
});
