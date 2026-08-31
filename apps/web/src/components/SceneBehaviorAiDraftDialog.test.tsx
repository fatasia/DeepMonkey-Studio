import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SceneBehaviorAiDraftDialog, intentSuggestions } from "./SceneBehaviorAiDraftDialog";

const target = { id: "robot-1", name: "搬运机器人", kind: "object" as const, context: "总装线" };
const intelligence = {
  targets: [target],
  references: [{ id: "scene-1", name: "总装线", kind: "scene" as const, context: "总装线" }],
  dataKeys: ["robot.temperature"],
  eventNames: ["click"],
};

describe("SceneBehaviorAiDraftDialog", () => {
  it("discloses exact context and keeps generation separate from save and run", () => {
    const html = renderToStaticMarkup(
      <SceneBehaviorAiDraftDialog
        locale="zh-CN"
        sceneId="scene-1"
        target={target}
        intelligence={intelligence}
        existingScript={{
          id: "script-1", name: "机器人行为", enabled: true, apiVersion: "1.0", entrypoint: "behavior",
          runtime: "worker-sandbox", code: "function onStart() {}", lifecycle: ["onStart"],
          capabilities: ["studio.object"], permissions: ["scene.read"], target: { kind: "object", id: "robot-1" },
        }}
        onClose={() => undefined}
        onInsertIntoEditor={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("scene-1");
    expect(html).toContain("搬运机器人");
    expect(html).toContain("生成并静态检查");
    expect(html).toContain("不会调用运行时");
    expect(html).not.toContain("应用并运行");
  });

  it("offers target-aware, project-data-aware intent examples", () => {
    expect(intentSuggestions(target, intelligence)).toContain("当 robot.temperature > 80 时颜色改为 #ef4444");
    expect(intentSuggestions({ ...target, kind: "component" }, intelligence)).toEqual(["隐藏组件", "显示组件"]);
    expect(intentSuggestions({ ...target, kind: "component", runtime: "unity" }, intelligence)).toEqual(["灯光强度设为 2.5"]);
  });
});
