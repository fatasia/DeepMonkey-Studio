import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { SceneModelInstanceDialog } from "./SceneModelInstanceDialog";

const instance = { id: "instance", assetModelId: "asset", name: "泵 A" } as LoadedSceneModel;
const assets = [{ id: "asset", name: "pump.glb", status: "ready", format: "glb", manifest: {} }] as ModelRecord[];
const props = { locale: "zh-CN" as const, instance, assets, busy: false, locked: false, error: "", onDuplicate: () => undefined, onReplace: () => undefined, onClose: () => undefined };

describe("model instance dialog semantics", () => {
  it("separates instance and asset names and explains the empty replacement state", () => {
    const html = renderToStaticMarkup(<SceneModelInstanceDialog {...props} />);
    for (const text of ["模型实例", "泵 A", "pump.glb", "暂无其他已就绪素材", "新增副本", "不复制脚本或业务绑定"]) expect(html).toContain(text);
    expect(html).toContain('aria-modal="true"');
    expect(html).not.toContain('class="instance-dialog-hint"');
    expect(html).toMatch(/class="button primary" disabled=""/);
  });
  it("exposes replacement failures without closing the dialog and explains locked state", () => {
    const html = renderToStaticMarkup(<SceneModelInstanceDialog {...props} locked error="结构不兼容，原实例未修改" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("结构不兼容，原实例未修改");
    expect(html).toContain("实例已锁定");
  });
  it("disables every transaction control while loading", () => {
    const html = renderToStaticMarkup(<SceneModelInstanceDialog {...props} busy />);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(4);
    expect(html).toContain('role="status"');
  });
});
