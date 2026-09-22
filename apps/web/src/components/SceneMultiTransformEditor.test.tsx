import { isValidElement, type ReactNode, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { SceneMultiTransformEditor } from "./SceneMultiTransformEditor";
import { DeferredNumberInput } from "./AppFormControls";
import { DEFAULT_SCENE_COORDINATES } from "../viewer/sceneCoordinates";
type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  return isValidElement<Record<string, any>>(node) ? [node, ...walk(node.props.children)] : [];
}
function harness(locked = new Set<string>()) {
  const transforms = new Map(["a", "b"].map((id, i) => [id, { position: { x: 11 + i, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }]));
  const flush = vi.fn(); const record = vi.fn();
  const engine = { getModelTransform: (id: string) => transforms.get(id), isModelLocked: (id: string) => locked.has(id), setModelTransform: vi.fn() };
  const props = { engine, locale: "zh-CN", sceneOrganizationSelection: new Set(["a", "b"]),
    sceneCoordinates: { ...DEFAULT_SCENE_COORDINATES, unit: "cm", origin: { x: 10, y: 0, z: 0 } },
    setRevision: vi.fn(), bindings: { sceneEditor: { recordSceneEdit: record }, sceneHistory: { flush } } } as unknown as Parameters<typeof SceneMultiTransformEditor>[0];
  const inputs = walk(SceneMultiTransformEditor(props)).filter(node => node.type === DeferredNumberInput);
  return { engine, flush, record, inputs, locked };
}
describe("multi transform edits", () => {
  it("shows mixed position and real project units, preserving other axes and locked members", () => {
    const h = harness(new Set(["b"]));
    expect(h.inputs[0]!.props.value).toBeUndefined();
    expect(h.inputs[0]!.props.ariaLabel).toBe("位置 X (cm)");
    expect(h.inputs[1]!.props.value).toBe(200);
    h.inputs[0]!.props.onCommit(500);
    expect(h.engine.setModelTransform).toHaveBeenCalledExactlyOnceWith("a", { position: [15, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(h.record).toHaveBeenCalledTimes(1); expect(h.flush).toHaveBeenCalledTimes(2);
  });
  it("converts degrees and checks locks again at commit time", () => {
    const h = harness(); h.locked.add("b"); h.inputs[4]!.props.onCommit(90);
    expect(h.engine.setModelTransform).toHaveBeenCalledExactlyOnceWith("a", expect.objectContaining({ rotation: [0, Math.PI / 2, 0] }));
  });
  it("disables all-locked selection and rejects invalid or degenerate edits", () => {
    const h = harness(new Set(["a", "b"]));
    expect(h.inputs.every(input => input.props.disabled)).toBe(true);
    h.inputs[0]!.props.onCommit(NaN); h.inputs[6]!.props.onCommit(0);
    expect(h.engine.setModelTransform).not.toHaveBeenCalled(); expect(h.record).not.toHaveBeenCalled();
  });
});
