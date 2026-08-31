import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createAiSceneScriptDraft } from "../ai/sceneScriptDraft";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { AiSceneScriptDraftReview } from "./AiSceneScriptDraftReview";

const target: SceneScriptTarget = { id: "robot-1", name: "搬运机器人", kind: "object", context: "装配线" };
const intelligence: SceneScriptIntelligenceContext = {
  targets: [target],
  references: [{ id: "scene-1", name: "装配线", kind: "scene", context: "装配线" }],
  dataKeys: [],
  eventNames: ["click"],
};

describe("AiSceneScriptDraftReview", () => {
  it("shows risk, static gates and a confirm-to-editor action without a run action", () => {
    const draft = createAiSceneScriptDraft({ intent: "定位并播放动画", sceneId: "scene-1", target, intelligence });
    const html = renderToStaticMarkup(
      <AiSceneScriptDraftReview locale="zh-CN" draft={draft} onCancel={vi.fn()} onInsertIntoEditor={vi.fn()} />,
    );

    expect(html).toContain("静态门禁已通过");
    expect(html).toContain("定位对象");
    expect(html).toContain("animation.control");
    expect(html).toContain("确认并插入编辑器");
    expect(html).toContain("不会保存、启用或运行");
    expect(html).not.toContain("确认并运行");
  });

  it("disables insertion for an ambiguous draft", () => {
    const draft = createAiSceneScriptDraft({ intent: "显示后隐藏", sceneId: "scene-1", target, intelligence });
    const html = renderToStaticMarkup(
      <AiSceneScriptDraftReview locale="zh-CN" draft={draft} onCancel={vi.fn()} onInsertIntoEditor={vi.fn()} />,
    );

    expect(html).toContain("尚不能插入");
    expect(html).toContain("同时识别到显示和隐藏");
    expect(html).toContain("disabled");
  });
});
