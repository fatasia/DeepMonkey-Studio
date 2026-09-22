import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MeasurementState, SceneAnnotationState, SceneLightState } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { AnnotationRow, LightRow, MeasurementRow } from "./SceneAuxiliaryRows";

type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  return isValidElement<Record<string, any>>(node) ? [node, ...walk(node.props.children)] : [];
}
const main = (node: ReactNode) => walk(node).find(item => item.type === "button" && item.props.className === "asset-main")!;
const light = { id: "light", name: "主光", type: "directional", color: "#ffffff", enabled: true } as SceneLightState;
const annotation = { id: "note", name: "标注", color: "#ffffff", visible: true } as SceneAnnotationState;

describe("auxiliary scene row selection", () => {
  it("keeps a light selected on a repeated click and clears other entity selection only on transition", () => {
    const select = vi.fn(), onEnvironmentOpen = vi.fn(); let selectedLightId = "";
    const onLightSelect = vi.fn((id: string) => { selectedLightId = id; });
    const render = () => LightRow({ light, locale: "zh-CN", selectedLightId, engine: { select } as unknown as ViewerEngine,
      onLightSelect, onEnvironmentOpen, onLightUpdate: vi.fn(), onLightTransform: vi.fn(), onLightRemove: vi.fn() });
    main(render()).props.onClick(); main(render()).props.onClick();
    expect(onLightSelect.mock.calls).toEqual([["light"], ["light"]]);
    expect(select).toHaveBeenCalledExactlyOnceWith(undefined); expect(onEnvironmentOpen).toHaveBeenCalledTimes(2);
    expect(main(render()).props["aria-pressed"]).toBe(true);
    expect(renderToStaticMarkup(render())).not.toContain("再次单击取消");
  });
  it("single clicks select the annotation without moving the camera; double click focuses", () => {
    const selectAnnotation = vi.fn(), focusAnnotation = vi.fn(), select = vi.fn();
    const row = AnnotationRow({ annotation, locale: "zh-CN", selectedAnnotationId: "note", selectedLightId: "",
      engine: { selectAnnotation, focusAnnotation, select } as unknown as ViewerEngine, onAnnotationUpdate: vi.fn(), onAnnotationRemove: vi.fn() });
    main(row).props.onClick(); main(row).props.onClick();
    expect(selectAnnotation.mock.calls).toEqual([["note"], ["note"]]); expect(focusAnnotation).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
    main(row).props.onDoubleClick(); expect(focusAnnotation).toHaveBeenCalledExactlyOnceWith("note");
    expect(main(row).props["aria-pressed"]).toBe(true);
  });
  it("clears an active light transform before selecting an annotation", () => {
    const calls: string[] = [];
    const row = AnnotationRow({ annotation, locale: "zh-CN", selectedLightId: "light",
      engine: { select: () => calls.push("clear"), selectAnnotation: () => calls.push("annotation") } as unknown as ViewerEngine,
      onAnnotationUpdate: vi.fn(), onAnnotationRemove: vi.fn() });
    main(row).props.onClick(); expect(calls).toEqual(["clear", "annotation"]);
  });
  it("keeps measurement as an explicit locate action with a native keyboard button", () => {
    const onFocus = vi.fn();
    const row = MeasurementRow({ locale: "zh-CN", measurement: { id: "m", distance: 2 } as MeasurementState, index: 0, onFocus, onRemove: vi.fn() });
    expect(main(row).props.title).toBe("定位测量"); expect(main(row).props.disabled).toBeUndefined();
    main(row).props.onClick(); expect(onFocus).toHaveBeenCalledOnce();
    expect(walk(row)[0]?.props["data-layer-keyboard-row"]).toBe("");
  });
});
