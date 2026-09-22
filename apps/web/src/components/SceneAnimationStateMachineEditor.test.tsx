import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANIMATION } from "../appDefaults";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { SceneAnimationStateMachineEditor } from "./SceneAnimationStateMachineEditor";

describe("SceneAnimationStateMachineEditor", () => {
  it("offers a product state-machine entry for the selected animated object", () => {
    const engine = {
      getSelected: () => ({ id: "robot", name: "Robot" }),
      listAnimationClips: () => [{ id: "idle", name: "Idle", duration: 2 }, { id: "work", name: "Work", duration: 3 }],
    } as unknown as ViewerEngine;
    const html = renderToStaticMarkup(<SceneAnimationStateMachineEditor engine={engine} locale="zh-CN" animation={DEFAULT_ANIMATION} onChange={() => undefined} />);
    expect(html).toContain("片段状态机");
    expect(html).toContain("从 2 个片段创建");
  });

  it("renders saved states, active state, and transition duration", () => {
    const engine = {
      getSelected: () => ({ id: "robot", name: "Robot" }),
      listAnimationClips: () => [{ id: "idle", name: "Idle", duration: 2 }, { id: "work", name: "Work", duration: 3 }],
    } as unknown as ViewerEngine;
    const animation = { ...DEFAULT_ANIMATION, stateMachine: { enabled: true, initialStateId: "idle", activeStateId: "work", transitionDuration: 0.25,
      states: [{ id: "idle", name: "Idle", modelId: "robot", clipId: "idle", loop: true }, { id: "work", name: "Work", modelId: "robot", clipId: "work", loop: true }],
      parameters: { advance: true }, transitions: [{ id: "work-idle", fromStateId: "work", toStateId: "idle", parameter: "advance", equals: true }] } };
    const html = renderToStaticMarkup(<SceneAnimationStateMachineEditor engine={engine} locale="en-US" animation={animation} onChange={() => undefined} />);
    expect(html).toContain("Clip state machine");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("value=\"0.25\"");
    expect(html).toContain("Evaluate");
    expect(html).toContain("advance = true → Idle");
  });
});
