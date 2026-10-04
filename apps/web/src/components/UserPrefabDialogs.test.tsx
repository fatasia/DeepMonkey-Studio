import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplyUserPrefabUpdateDialog, SaveUserPrefabDialog, UserPrefabRowBadge } from "./UserPrefabDialogs";
import type { UserPrefabUpdateDiff } from "@bim-studio/contracts";

describe("SaveUserPrefabDialog", () => {
  it("renders name and category fields with a save action", () => {
    const markup = renderToStaticMarkup(<SaveUserPrefabDialog locale="zh-CN" defaultName="预制体 1" onSave={() => undefined} onClose={() => undefined} />);
    expect(markup).toContain("存为预制体");
    expect(markup).toContain("预制体名称");
    expect(markup).toContain("预制体分类");
    expect(markup).toContain("取消");
  });

  it("blocks submit for blank name", () => {
    const markup = renderToStaticMarkup(<SaveUserPrefabDialog locale="zh-CN" defaultName="   " onSave={() => undefined} onClose={() => undefined} />);
    expect(markup).toContain("disabled");
  });
});

describe("ApplyUserPrefabUpdateDialog", () => {
  const diff: UserPrefabUpdateDiff = {
    prefabId: "userprefab:pump",
    fromVersion: 1,
    toVersion: 2,
    added: [{ sourceId: "gauge", name: "压力表", kind: "primitive" }],
    removed: [{ sceneObjectId: "scene-pump", sourceId: "pump", name: "泵体", reason: "prototype" }],
    changed: [
      { sceneObjectId: "scene-motor", sourceId: "motor", name: "电机", path: "transform.position.x", from: 1, to: 2, overridden: false },
      { sceneObjectId: "scene-motor", sourceId: "motor", name: "电机", path: "opacity", from: 0.4, to: 1, overridden: true },
    ],
  };

  it("renders added/removed/changed sections and keeps overrides visually separate", () => {
    const markup = renderToStaticMarkup(<ApplyUserPrefabUpdateDialog locale="zh-CN" prefabName="卧式泵组" diff={diff} onApply={() => undefined} onClose={() => undefined} />);
    expect(markup).toContain("新增成员（1）");
    expect(markup).toContain("移除成员（1）");
    expect(markup).toContain("属性更新（1）");
    expect(markup).toContain("保留实例覆盖（1）");
    expect(markup).toContain("位置.x");
    expect(markup).toContain("0.4（覆盖保留）");
    expect(markup).toContain("v1 → v2");
  });

  it("marks prototype removals and link cleanups distinctly", () => {
    const markup = renderToStaticMarkup(<ApplyUserPrefabUpdateDialog locale="zh-CN" prefabName="卧式泵组" diff={{ ...diff, removed: [{ ...diff.removed[0]!, reason: "missing-in-scene" }] }} onApply={() => undefined} onClose={() => undefined} />);
    expect(markup).toContain("场景中已不存在，仅清理链接");
  });

  it("shows a no-op status when nothing changes", () => {
    const markup = renderToStaticMarkup(<ApplyUserPrefabUpdateDialog locale="zh-CN" prefabName="卧式泵组" diff={{ ...diff, added: [], removed: [], changed: [] }} onApply={() => undefined} onClose={() => undefined} />);
    expect(markup).toContain("属性无变化，仅推进实例版本");
  });
});

describe("UserPrefabRowBadge", () => {
  it("distinguishes member, pending and overridden states", () => {
    expect(renderToStaticMarkup(<UserPrefabRowBadge locale="zh-CN" />)).toContain(">预制<");
    expect(renderToStaticMarkup(<UserPrefabRowBadge locale="zh-CN" pending />)).toContain("待更新");
    expect(renderToStaticMarkup(<UserPrefabRowBadge locale="zh-CN" overridden />)).toContain("覆盖");
  });
});
