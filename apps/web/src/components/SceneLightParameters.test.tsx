import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SceneLightState } from "@bim-studio/contracts";
import { SceneLightParameters } from "./SceneLightParameters";
import { DeferredNumberInput } from "./AppFormControls";
function walk(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...walk(node.props.children)];
}
function fields(type: SceneLightState["type"]) {
  const onUpdate = vi.fn();
  const nodes = walk(SceneLightParameters({ locale: "zh-CN", light: { id: "light", name: "灯", type,
    enabled: true, color: "#ffffff", intensity: 1 }, onUpdate }));
  return { nodes, onUpdate, numbers: nodes.filter(node => node.type === DeferredNumberInput) };
}
describe("light parameters by supported light type", () => {
  it("commits distance, decay and penumbra through the existing light update boundary", () => {
    const { numbers, onUpdate } = fields("spot");
    expect(numbers.map(node => node.props.value)).toEqual([0, 2, .25]);
    expect(numbers.map(node => [node.props.min, node.props.max])).toEqual([[0, 1_000_000], [0, 4], [0, 1]]);
    numbers[0]!.props.onCommit(18); numbers[1]!.props.onCommit(1.5); numbers[2]!.props.onCommit(.6);
    expect(onUpdate.mock.calls.map(call => call[0])).toEqual([{ distance: 18 }, { decay: 1.5 }, { penumbra: .6 }]);
  });
  it("offers only local attenuation for point lights and no local parameters for directional/ambient/area lights", () => {
    expect(fields("point").numbers).toHaveLength(2);
    for (const type of ["ambient", "directional", "rectArea"] as const) expect(fields(type).numbers).toHaveLength(0);
  });
  it("uses the renderer's ground default and updates hemisphere ground independently of sky", () => {
    const { nodes, onUpdate } = fields("hemisphere");
    const color = nodes.find(node => node.type === "input")!;
    expect(color.props.value).toBe("#3b4249");
    color.props.onChange({ target: { value: "#203040" } });
    expect(onUpdate).toHaveBeenCalledWith({ groundColor: "#203040" });
    expect(fields("spot").nodes.some(node => node.props.type === "color")).toBe(false);
  });
});
