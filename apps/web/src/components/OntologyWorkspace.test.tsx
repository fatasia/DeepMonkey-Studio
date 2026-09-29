import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OntologyPackage } from "@bim-studio/contracts";
import OntologyWorkspace, { AssetList, PropertyEditor, StatusBadge } from "./OntologyWorkspace";

const pkg: OntologyPackage = {
  schemaVersion: 1,
  id: "pkg-1",
  name: "产线设备本体",
  domain: "manufacturing",
  version: 2,
  revision: 5,
  objects: [
    {
      id: "o1", key: "Device", label: "设备", domain: "manufacturing",
      primaryKeys: ["device_id"],
      properties: [{ key: "device_id", label: "设备编号", type: "string", confirmed: true }],
      sourceBindings: [{ kind: "dataset", sourceId: "ds-1", fieldMappings: [{ propertyKey: "device_id", fieldKey: "device_id" }], schemaFingerprint: "abc123" }],
      aliases: [], identityMappings: [], status: "published", version: 2, owner: "alice",
    },
  ],
  relations: [],
  actions: [],
  events: [],
  metrics: [],
  identityMappings: [],
  goldenQuestions: [],
  policies: [],
  evidence: [],
  impactReviewed: true,
  impactReviewedBy: "bob",
  status: "published",
  owner: "alice",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
};

describe("ontology workspace", () => {
  it("renders the loading state without exploding (workspace mounts lazily inside the semantic step)", () => {
    const html = renderToStaticMarkup(<OntologyWorkspace projectId="p" locale="zh-CN" owner="studio-user" onDirtyChange={undefined} />);
    expect(html).toContain("正在加载本体包");
    expect(html).toContain("role=\"status\"");
  });

  it("status badge encodes state with tone class, icon and text (not color alone)", () => {
    const html = renderToStaticMarkup(<StatusBadge status="published" locale="zh-CN" />);
    expect(html).toContain("ontology-status-published");
    expect(html).toContain("已发布");
    expect(html).toContain("svg");
    const retired = renderToStaticMarkup(<StatusBadge status="retired" locale="zh-CN" />);
    expect(retired).toContain("ontology-status-retired");
    expect(retired).toContain("已退役");
  });

  it("asset list shows empty guidance and a create affordance; rows expose key and counts", () => {
    const empty = renderToStaticMarkup(<AssetList kind="relations" pkg={pkg} locale="zh-CN" selectedId={undefined} onSelect={() => undefined} onCreate={() => undefined} onDelete={() => undefined} />);
    expect(empty).toContain("暂无资产");
    const populated = renderToStaticMarkup(<AssetList kind="objects" pkg={pkg} locale="zh-CN" selectedId="o1" onSelect={() => undefined} onCreate={() => undefined} onDelete={() => undefined} />);
    expect(populated).toContain("设备");
    expect(populated).toContain("1 属性");
    expect(populated).toContain('class="active"');
  });

  it("property editor marks unconfirmed candidates as pending (gate 1 awareness)", () => {
    const html = renderToStaticMarkup(
      <PropertyEditor
        properties={[
          { key: "device_id", label: "设备编号", type: "string", confirmed: true },
          { key: "temperature", label: "温度", type: "number", confirmed: false },
        ]}
        locale="zh-CN"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("未确认属性会阻止发布");
    expect(html).toContain("待确认");
    expect(html).toContain("已确认");
  });
});
