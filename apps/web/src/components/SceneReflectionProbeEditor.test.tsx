import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ENVIRONMENT } from "../appDefaults";
import { SceneReflectionProbeEditor } from "./SceneReflectionProbeEditor";

describe("local reflection author controls", () => {
  it("offers an empty inherited-source configuration with a bounded add action", () => {
    const html = renderToStaticMarkup(<SceneReflectionProbeEditor locale="zh-CN" value={DEFAULT_ENVIRONMENT} assets={[]} onChange={vi.fn()} />);
    expect(html).toContain("局部反射探针"); expect(html).toContain("0/2"); expect(html).toContain("Deep WebGPU");
    expect(html).toContain("添加反射探针"); expect(html).not.toContain("disabled");
  });
  it("shows saved source, spatial units, explicit disabled probes and the two-probe budget", () => {
    const probe = { id: "p1", name: "Room", enabled: false, center: { x: 1, y: 2, z: 3 }, halfExtents: { x: 4, y: 5, z: 6 },
      influenceRadius: 2, blendDistance: 1, environmentMapUrl: "/saved.hdr", environmentMapName: "Saved HDR" };
    const html = renderToStaticMarkup(<SceneReflectionProbeEditor locale="en-US" value={{ ...DEFAULT_ENVIRONMENT,
      reflectionProbes: [probe, { ...probe, id: "p2", name: "Room 2", enabled: true }] }} assets={[]} onChange={vi.fn()} />);
    expect(html).toContain("Room Center X (m)"); expect(html).toContain("Room Half extents Z (m)");
    expect(html).toContain("Saved HDR"); expect(html).toContain("Inherit current environment");
    expect(html).toContain("Current budget supports two probes"); expect(html).toContain("disabled");
  });
});

// Invoke actual controlled input callbacks; HTML min/max alone does not validate author state.
describe("reflection probe field contract", () => {
  it("keeps out-of-contract numbers out of the scene and accepts inclusive boundaries", () => {
    const onChange = vi.fn(), probe = { id: "room", name: "Room", enabled: true,
      center: { x: -3.5, y: 2, z: 0 }, halfExtents: { x: 2.5, y: 2, z: 5 }, influenceRadius: 1.5, blendDistance: .8 };
    const fields = new Map<string, (event: { target: { valueAsNumber: number } }) => void>();
    const visit = (node: ReactNode) => Children.forEach(node, child => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "input" && child.props["aria-label"]) fields.set(child.props["aria-label"] as string,
        child.props.onChange as (event: { target: { valueAsNumber: number } }) => void);
      visit(child.props.children as ReactNode);
    });
    visit(SceneReflectionProbeEditor({ locale: "en-US", value: { ...DEFAULT_ENVIRONMENT, reflectionProbes: [probe] }, assets: [], onChange }));
    for (const [label, rejected, accepted] of [
      ["Room Center X (m)", [-1e9 - 1, 1e9 + 1, NaN, Infinity], [-1e9, 1e9]],
      ["Room Half extents X (m)", [0, 1e-7, 1e9 + 1, NaN], [1e-6, 1e9]],
      ["Room Blend distance (m)", [-.1, 1e9 + 1, Infinity], [0, 1e9]],
      ["Room Influence radius (m)", [-.1, 1e9 + 1, NaN], [0, 1e9]],
    ] as const) {
      const callback = fields.get(label); expect(callback, label).toBeDefined();
      onChange.mockClear();
      for (const number of rejected) callback!({ target: { valueAsNumber: number } });
      expect(onChange).not.toHaveBeenCalled();
      for (const number of accepted) callback!({ target: { valueAsNumber: number } });
      expect(onChange).toHaveBeenCalledTimes(accepted.length);
    }
  });
});
