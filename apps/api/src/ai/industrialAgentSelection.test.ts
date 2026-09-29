import { describe, expect, it } from "vitest";
import { ontologyClarificationCandidates, selectedAgentDatasets, validateAgentDatasetSelection } from "./industrialAgentSelection.js";
import type { OntologyPackage } from "@bim-studio/contracts";

const catalog = { projectId: "p", total: 2, truncated: false, datasets: ["a", "b"].map(id => ({ id, name: `源 ${id}`, fields: [{ key: "v", label: "值", type: "number" as const }], fieldsTruncated: false, updatedAt: "2026-09-05" })) };
const decision = { kind: "request-input", rationale: "有歧义", question: "请选择", options: [{ id: "a", label: "假的名称" }, { id: "b", label: "假的名称" }] };

function ontologyPackage(overrides: Partial<OntologyPackage> = {}): OntologyPackage {
  return {
    id: "pkg-1", name: "产线本体", domain: "manufacturing", version: 1, revision: 1, status: "published",
    createdAt: "2026-09-01", updatedAt: "2026-09-02", owner: "engineer",
    objects: [{ id: "o1", key: "pump", label: "泵", domain: "manufacturing", primaryKeys: ["tag"], properties: [], sourceBindings: [], aliases: [], identityMappings: [], status: "published", version: 1, owner: "engineer" }],
    relations: [], actions: [], events: [], goldenQuestions: [], ...overrides,
  } as OntologyPackage;
}

const candidates = ontologyClarificationCandidates([ontologyPackage()]);

describe("server-owned Agent choices", () => {
  it("uses server names and field descriptions, rejecting foreign and duplicate IDs", () => {
    expect(validateAgentDatasetSelection(decision, catalog)).toMatchObject({ options: [{ id: "a", label: "源 a", description: "值" }, { id: "b", label: "源 b" }] });
    expect(() => validateAgentDatasetSelection({ ...decision, options: [...decision.options, { id: "foreign", label: "外部" }] }, catalog)).toThrow("目录以外");
    expect(() => validateAgentDatasetSelection({ ...decision, options: [decision.options[0], decision.options[0]] }, catalog)).toThrow("重复");
  });
  it("revalidates the latest selection against the current catalog", () => {
    const checkpoint = { selections: [{ option: { id: "b", label: "旧名" }, selectedBy: "operator", selectedAt: "now" }] } as never;
    expect(selectedAgentDatasets(checkpoint, catalog)).toMatchObject([{ id: "b", name: "源 b", kind: "dataset" }]);
    expect(() => selectedAgentDatasets(checkpoint, { ...catalog, datasets: [] })).toThrow("已删除");
  });

  // T2（审计 P1-9）：澄清候选从"仅数据集目录"扩展为"数据集 ∪ 已发布本体对象"。
  // 以前会坏：模型提名本体对象 ID → validateAgentDatasetSelection 抛"目录以外" → 整轮运行终局失败；
  // 现在锁死：发布包对象成为合法候选，未发布对象与目录外 ID 仍被拒绝。
  it("accepts published ontology object candidates as clarification options", () => {
    expect(candidates).toEqual([{ id: "ontology:pkg-1:pump", label: "泵", description: "产线本体 · manufacturing" }]);
    // 决策合同要求 2-8 个候选：混合"数据集 ∪ 本体对象"是 T2 的目标形态。
    const mixedDecision = { ...decision, options: [{ id: "a", label: "模型编的" }, { id: "ontology:pkg-1:pump", label: "模型编的" }] };
    expect(validateAgentDatasetSelection(mixedDecision, catalog, candidates)).toMatchObject({
      options: [{ id: "a", label: "源 a", description: "值" }, { id: "ontology:pkg-1:pump", label: "泵" }],
    });
    // 目录外 + 本体候选外（含未发布对象）依旧拒绝，不因扩展放宽信任边界。
    expect(() => validateAgentDatasetSelection({ ...decision, options: [{ id: "a", label: "x" }, { id: "ontology:pkg-9:pump", label: "别的包" }] }, catalog, candidates)).toThrow("目录以外");
    expect(() => validateAgentDatasetSelection({ ...decision, options: [{ id: "a", label: "x" }, { id: "ontology:pkg-1:valve", label: "未发布" }] }, catalog, candidates)).toThrow("目录以外");
  });
  it("skips draft packages and retired objects when building candidates", () => {
    const draft = ontologyClarificationCandidates([
      ontologyPackage({ id: "pkg-draft", status: "draft" }),
      ontologyPackage({ ...ontologyPackage(), objects: [{ ...ontologyPackage().objects[0]!, key: "retired-object", status: "retired" }] }),
    ]);
    expect(draft).toEqual([]);
  });
  it("returns an ontology selection as object scope instead of failing the next decision round", () => {
    // 以前会坏：用户点了本体对象选项 → selectedAgentDatasets 抛"已删除" → 下一轮 decide 直接崩溃；
    // 现在锁死：本体选择以 kind=ontology 范围声明返回，不抛错。
    const checkpoint = { selections: [{ option: { id: "ontology:pkg-1:pump", label: "泵" }, selectedBy: "operator", selectedAt: "now" }] } as never;
    expect(selectedAgentDatasets(checkpoint, catalog, candidates)).toEqual([
      { kind: "ontology", id: "ontology:pkg-1:pump", name: "泵", selectedBy: "operator", selectedAt: "now" },
    ]);
  });
  it("caps ontology candidates at the same bound as the dataset catalog", () => {
    const many = Array.from({ length: 60 }, (_, index) => ontologyPackage({ id: `pkg-${index}`, objects: [{ ...ontologyPackage().objects[0]! }] }));
    expect(ontologyClarificationCandidates(many)).toHaveLength(50);
  });
});
