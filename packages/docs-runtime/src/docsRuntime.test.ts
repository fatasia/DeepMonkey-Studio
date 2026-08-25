import { describe, expect, it } from "vitest";
import { createDocsCatalog, groupDocsByCategory, parseMarkdown, searchDocs, validateDocsLinks } from "./index.js";

const documents = createDocsCatalog([
  {
    id: "dashboard-scene",
    category: "快速开始",
    order: 1,
    version: "0.9.0",
    markdown: "# 创建 2D 并绑定 3D\n\n从二维大屏进入三维场景。\n\n## 绑定场景\n\n选择场景和摄像机。\n\n[打开脚本](/docs/behavior-script#运行脚本)"
  },
  {
    id: "behavior-script",
    category: "可编程能力",
    order: 2,
    version: "0.9.0",
    markdown: "# 行为脚本\n\n用脚本控制摄像机和设备。\n\n## 运行脚本\n\n```ts\nscene.camera.flyTo('line-1')\n```"
  }
]);

describe("docs runtime", () => {
  it("builds ordered documents, sections and category navigation", () => {
    expect(documents[0]).toMatchObject({ id: "dashboard-scene", title: "创建 2D 并绑定 3D" });
    expect(documents[0]?.sections).toEqual([{ id: "绑定场景", title: "绑定场景", level: 2 }]);
    expect(groupDocsByCategory(documents).map((group) => group.title)).toEqual(["快速开始", "可编程能力"]);
  });

  it("searches Chinese text and ranks heading hits", () => {
    const camera = searchDocs(documents, "摄像机");
    expect(camera.map((result) => result.document.id)).toEqual(["dashboard-scene", "behavior-script"]);
    expect(searchDocs(documents, "绑定场景")[0]).toMatchObject({ document: { id: "dashboard-scene" }, section: { id: "绑定场景" } });
    expect(searchDocs(documents, "二维 场景")[0]?.document.id).toBe("dashboard-scene");
    expect(searchDocs(documents, "不存在")).toEqual([]);
  });

  it("parses safe render blocks without producing HTML", () => {
    expect(parseMarkdown("## 标题\n\n- 一\n- 二\n\n`code` [链接](https://example.com)")).toEqual([
      { type: "heading", level: 2, id: "标题", content: [{ type: "text", value: "标题" }] },
      { type: "list", ordered: false, items: [[{ type: "text", value: "一" }], [{ type: "text", value: "二" }]] },
      { type: "paragraph", content: [{ type: "code", value: "code" }, { type: "text", value: " " }, { type: "link", label: "链接", href: "https://example.com", external: true }] }
    ]);
  });

  it("validates document links, anchors and unsafe schemes", () => {
    expect(validateDocsLinks(documents)).toEqual([]);
    const broken = createDocsCatalog([{ id: "broken", category: "测试", order: 1, version: "1", markdown: "# Broken\n\n[缺失](/docs/none) [锚点](#none) [危险](javascript:alert(1))" }]);
    expect(validateDocsLinks(broken).map((issue) => issue.reason)).toEqual(["missing-document", "missing-section", "unsafe-scheme"]);
  });

  it("rejects duplicate document identifiers", () => {
    expect(() => createDocsCatalog([
      { id: "same", category: "A", order: 1, version: "1", markdown: "# A" },
      { id: "same", category: "B", order: 2, version: "1", markdown: "# B" }
    ])).toThrow("文档 ID 重复");
  });
});
