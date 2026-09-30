import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OntologyGraphNode, OntologyPackage } from "@bim-studio/contracts";
import OntologyGraphInspector from "./OntologyGraphInspector";

function fixturePackage(): OntologyPackage {
  // 与 OntologyGraphView.test.tsx 的 fixturePackage 同构：published 包 + action:diagnose_device 绑定 Device。
  return {
    id: "pkg-factory", name: "工厂本体", status: "published", version: 3, schemaVersion: 1,
    objects: [{ key: "Device", label: "设备", status: "published", version: 2, source: { kind: "dataset", sourceId: "ds-devices" }, propertyIds: [], identityMapping: { keyField: "device_id" } }],
    relations: [], datasets: [],
    actions: [{ key: "diagnose_device", label: "诊断设备", status: "published", version: 1, boundObject: "Device", effect: "read", riskLevel: "low", approvalRequired: false, idempotencyRequired: true, preconditions: [], impactScope: ["Device"], authorizedScopes: ["read"], toolBinding: { kind: "capability", id: "data.query", version: "1" }, source: { kind: "manifest" } }],
    events: [],
  } as unknown as OntologyPackage;
}

const actionNode: OntologyGraphNode = {
  id: "action:diagnose_device", kind: "action", key: "diagnose_device", label: "诊断设备",
  status: "published", version: 1, effect: "read", riskLevel: "low", approvalRequired: false,
};

function renderInspector(previewAction?: (input: { actionKey: string; target: { objectKey: string; canonicalId: string } }) => Promise<unknown>) {
  return renderToStaticMarkup(<OntologyGraphInspector pkg={fixturePackage()} selection={{ kind: "node", id: "action:diagnose_device" }}
    node={actionNode} edge={undefined} locale="zh-CN" onFocusRoot={() => undefined} onCollapse={() => undefined}
    onReset={() => undefined} {...(previewAction ? { previewAction: previewAction as never } : {})} />);
}

describe("行动节点「行动预览」面板（H-C4-P3 用户面）", () => {
  it("传入 previewAction 时渲染预览面板与重跑按钮（选中即自动预览）", () => {
    const html = renderInspector(vi.fn().mockResolvedValue({}));
    expect(html).toContain("ontology-graph-action-preview");
    expect(html).toContain("重新生成预览");
  });

  it("未传 previewAction 时整面板缺省不渲染（缺省不渲染口径）", () => {
    const html = renderInspector();
    expect(html).not.toContain("ontology-graph-action-preview");
    expect(html).not.toContain("重新生成预览");
  });

  it("行动未绑定对象时面板可见但预览按钮禁用（不猜测 canonicalId）", () => {
    const pkg = fixturePackage() as OntologyPackage & { actions: Array<Record<string, unknown>> };
    (pkg.actions[0] as Record<string, unknown>).boundObject = undefined;
    const html = renderToStaticMarkup(<OntologyGraphInspector pkg={pkg} selection={{ kind: "node", id: "action:diagnose_device" }}
      node={actionNode} edge={undefined} locale="zh-CN" onFocusRoot={() => undefined} onCollapse={() => undefined}
      onReset={() => undefined} previewAction={vi.fn().mockResolvedValue({}) as never} />);
    expect(html).toContain("行动未绑定对象");
    expect(html).toContain("disabled");
  });
});
