import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelRecord, ProjectAssetRecord } from "@bim-studio/contracts";
import { resourceBrowseLink, resourceFileLink, readResourceBrowseTarget } from "./resourceLinks";
import { ResourceLinkButton } from "./ResourceLinkButton";

describe("resource links", () => {
  it("uses the deployed server and original model file, preserving encoded names", () => {
    const model = { sourceUrl: "/assets/projects/p/models/m/source/%E6%B3%B5.glb" } as ModelRecord;
    expect(resourceFileLink(model, "https://twin.example.com")).toBe("https://twin.example.com/assets/projects/p/models/m/source/%E6%B3%B5.glb");
    expect(resourceFileLink({ url: "https://cdn.example.com/part.png?signature=stored" } as ProjectAssetRecord, "https://twin.example.com")).toBe("https://cdn.example.com/part.png?signature=stored");
  });
  it("rejects temporary previews, credentials and missing addresses", () => {
    for (const url of ["blob:https://example.com/preview", "data:image/png;base64,abc", "file:///private/file.glb", "https://user:password@example.com/asset", ""]) {
      expect(() => resourceFileLink({ url } as ProjectAssetRecord, "https://twin.example.com")).toThrow();
    }
  });
  it("round trips catalog and built-in browse links without user credentials or project mutations", () => {
    for (const kind of ["library", "2d", "template", "prefab"] as const) {
      const link = new URL(resourceBrowseLink(kind, "设备 & A", "https://twin.example.com"));
      expect(link.pathname + link.search).toBe("/manager?tab=assets");
      expect(readResourceBrowseTarget(link.hash)).toEqual({ kind, id: "设备 & A" });
      expect(link.href).not.toContain("token");
    }
    expect(readResourceBrowseTarget("#resourceKind=unknown&resource=x")).toBeUndefined();
    expect(readResourceBrowseTarget("#resourceKind=library&resource=%00")).toBeUndefined();
  });
  it("names file and authenticated browse actions separately", () => {
    expect(renderToStaticMarkup(<ResourceLinkButton locale="zh-CN" name="泵" resource={{ sourceUrl: "/assets/pump.glb" } as ModelRecord} />)).toContain("复制外链 泵");
    expect(renderToStaticMarkup(<ResourceLinkButton locale="zh-CN" name="泵" browse={{ kind: "library", id: "pump" }} />)).toContain("复制浏览链接 泵");
  });
});
