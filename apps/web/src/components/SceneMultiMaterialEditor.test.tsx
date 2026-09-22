import { isValidElement, type ReactNode, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { SceneMultiMaterialEditor } from "./SceneMultiMaterialEditor";
import { DeferredNumberInput } from "./AppFormControls";
type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  return isValidElement<Record<string, any>>(node) ? [node, ...walk(node.props.children)] : [];
}
function harness() {
  const locked = new Set<string>();
  const slots = { "gltf:0": { roughness: 0.2, metalness: 0.9 }, "gltf:1": { roughness: 0.8, doubleSided: true } };
  const engine = { isModelLocked: (id: string) => locked.has(id),
    getModelMaterialStates: vi.fn((id: string) => id === "a" ? [{ roughness: 0.2, metalness: 0.9 }, { roughness: 0.8, metalness: 0.1 }] : [{ roughness: 0.2, metalness: 0.9 }]),
    getModelMaterialOverride: () => ({ slotOverrides: slots }), setModelMaterial: vi.fn() };
  const flush = vi.fn(), record = vi.fn();
  const props = { engine, locale: "zh-CN", sceneOrganizationSelection: new Set(["a", "b"]), setRevision: vi.fn(),
    bindings: { sceneHistory: { flush }, sceneEditor: { recordSceneEdit: record } } } as unknown as Parameters<typeof SceneMultiMaterialEditor>[0];
  const fields = () => walk(SceneMultiMaterialEditor(props)).filter(node => node.type === DeferredNumberInput);
  return { engine, locked, slots, flush, record, fields };
}
describe("multi material authoring", () => {
  it("includes all material slots in mixed values, not just the first mesh", () => {
    const h = harness();
    expect(h.fields()[0]!.props.value).toBeUndefined(); expect(h.fields()[1]!.props.value).toBeUndefined();
    expect(h.fields()[2]!.props.disabled).toBe(true);
  });
  it("changes only one field in every slot, keeps locked instances and records one transaction", () => {
    const h = harness(); const input = h.fields()[0]!; h.locked.add("b"); input.props.onCommit(0.5);
    expect(h.engine.setModelMaterial).toHaveBeenCalledExactlyOnceWith("a", { roughness: 0.5, slotOverrides: {
      "gltf:0": { roughness: 0.5, metalness: 0.9 }, "gltf:1": { roughness: 0.5, doubleSided: true },
    } });
    expect(h.slots["gltf:0"].roughness).toBe(0.2);
    expect(h.record).toHaveBeenCalledTimes(1); expect(h.flush).toHaveBeenCalledTimes(2);
  });
  it("does not publish invalid values or edit an entirely locked selection", () => {
    const h = harness(); h.fields()[0]!.props.onCommit(NaN);
    h.locked.add("a"); h.locked.add("b"); expect(h.fields().every(input => input.props.disabled)).toBe(true);
    h.fields()[0]!.props.onCommit(0.5); expect(h.engine.setModelMaterial).not.toHaveBeenCalled();
  });
});
