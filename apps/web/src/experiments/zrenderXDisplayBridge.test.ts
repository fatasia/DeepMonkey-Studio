import { afterEach, describe, expect, it } from "vitest";
import { ZRenderPainterCommandBatchExperiment, type ChartCommandBatch, type DynamicBarFrameInput } from "./zrenderPainterCommandBatch";
import { ZRenderXDisplayBridge } from "./zrenderXDisplayBridge";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";

const live: ZRenderPainterCommandBatchExperiment[] = [];
afterEach(() => { for (const source of live.splice(0)) source.dispose(); });
function fixture() {
  const source = new ZRenderPainterCommandBatchExperiment(); live.push(source);
  const input: DynamicBarFrameInput = { chartId: "x.dynamic-bar", categories: ["A", "B", "C"], values: [12, 24, 18],
    logicalWidth: 320, logicalHeight: 180, domainMax: 30, color: "#5070dd" };
  const frame = (patch: Partial<DynamicBarFrameInput> = {}): ChartCommandBatch => {
    const result = source.renderFrame({ ...input, ...patch });
    if (!result.ok) throw new Error(result.error.message);
    return result.batch;
  };
  return { frame, bridge: new ZRenderXDisplayBridge() };
}
function display(json: string) {
  const packageValue = JSON.parse(json);
  return packageValue.payloads["x:zrender"].content.request.calls[0].args;
}

describe("ZRender X display bridge", () => {
  it("freezes actual ECharts geometry, negative bar heights and delta updates into X packages", () => {
    const { frame, bridge } = fixture();
    const first = bridge.freeze(frame());
    const initial = display(first.packageJson);
    expect(first.runtimePackage.schemaVersion).toBe(6);
    expect(initial.resources).toHaveLength(3);
    expect(initial.resources[0].verbs[0].y).toBe(180);
    expect(initial.resources[0].verbs[2].y).toBe(108);
    const delta = frame({ values: [12, 15, 18] });
    expect(delta.commands).toHaveLength(1);
    const updated = display(bridge.freeze(delta).packageJson);
    expect(updated.resources[1].verbs[2].y).toBe(90);
    expect(updated.resources[0].verbs).toEqual(initial.resources[0].verbs);
    expect(updated.commands[0].fill).toEqual(initial.commands[0].fill);
  });
  it("applies removals and repeated empty deltas without leaving ghost bars", () => {
    const { frame, bridge } = fixture();
    bridge.freeze(frame());
    const patch = { categories: ["A", "B"], values: [12, 24] };
    const smaller = display(bridge.freeze(frame(patch)).packageJson);
    expect(smaller.commands).toHaveLength(2);
    const repeated = frame(patch);
    expect(repeated.commands).toEqual([]);
    expect(display(bridge.freeze(repeated).packageJson).resources.map((r: { verbs: unknown }) => r.verbs))
      .toEqual(smaller.resources.map((r: { verbs: unknown }) => r.verbs));
  });
  it.each(["hash", "gap", "duplicate", "foreign", "dependency", "size", "count"])("rejects %s without advancing the accepted delta state", kind => {
    const { frame, bridge } = fixture();
    bridge.freeze(frame());
    const next = frame({ values: [12, 15, 18] });
    const bad = structuredClone(next);
    if (kind === "hash") Object.assign(bad, { outputHash: "0".repeat(64) });
    if (kind === "gap") Object.assign(bad, { epoch: 3 });
    if (kind === "duplicate") Object.assign(bad, { commands: [...bad.commands, bad.commands[0]] });
    if (kind === "foreign") Object.assign(bad, { chartId: "another" });
    if (kind === "dependency") Object.assign(bad, { dependencies: { echarts: "7", zrender: "7" } });
    if (kind === "size") Object.assign(bad, { logicalWidth: -1 });
    if (kind === "count") Object.assign(bad, { retainedRectCount: 2 });
    expect(() => bridge.freeze(bad)).toThrow();
    expect(display(bridge.freeze(next).packageJson).revision).toBe(2);
    expect(() => bridge.freeze(next)).toThrow(/epoch/);
  });
  it("owns its accepted snapshot independently of subsequent caller mutation", () => {
    const { frame, bridge } = fixture();
    const first = frame(); bridge.freeze(first);
    const command = first.commands[0];
    if (command?.op !== "upsert-rect") throw new Error("missing rect");
    (command.fill as unknown as number[])[0] = 1;
    const next = frame({ values: [12, 15, 18] });
    expect(() => bridge.freeze(next)).not.toThrow();
  });
  it("produces identical package bytes from independent real ECharts runs", () => {
    const a = fixture(), b = fixture();
    expect(runtimeContentSha256(a.bridge.freeze(a.frame()).runtimePackage))
      .toBe(runtimeContentSha256(b.bridge.freeze(b.frame()).runtimePackage));
  });
});
