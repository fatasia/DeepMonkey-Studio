import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import { StudioDeepShadowSession } from "./StudioDeepShadowSession";

type Lights = NonNullable<RenderView["lights"]>;
function lights(mapSize: number, castShadow = true): Lights {
  return { directional: [{ directionWorld: [0, -1, 0], color: [1, 1, 1], intensity: 1, castShadow,
    shadow: { viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      mapSize, bias: -0.002, normalBias: 0.02, intensity: 0.8, radius: 2 } }] };
}
function fixture() {
  const requests: { mapSize: number; signal: AbortSignal; resolve: (result: "staged" | "superseded") => void;
    reject: (reason: Error) => void }[] = [];
  const onReady = vi.fn(), onFailure = vi.fn();
  const stage = vi.fn((mapSize: number, signal: AbortSignal) => new Promise<"staged" | "superseded">((resolve, reject) => {
    requests.push({ mapSize, signal, resolve, reject });
  }));
  const session = new StudioDeepShadowSession({ initialMapSize: 512, stage, onReady, onFailure });
  return { session, stage, requests, onReady, onFailure };
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("Studio shadow allocation session", () => {
  it("uses current allocation while preparing, and only acknowledges submitted frame evidence", async () => {
    const { session, requests, onReady } = fixture(); const source = lights(2048);
    expect(session.lights(source).directional?.[0]?.shadow).toMatchObject({ mapSize: 512, bias: -0.002 });
    expect(source.directional?.[0]?.shadow?.mapSize).toBe(2048);
    session.lights(source); expect(requests).toHaveLength(1);
    requests[0]!.resolve("staged"); await flush(); expect(onReady).toHaveBeenCalledOnce();
    expect(session.lights(source)).toBe(source);
    session.acknowledgeMapSize(2048);
    const larger = session.lights(lights(4096));
    expect(larger.directional?.[0]?.shadow?.mapSize).toBe(2048);
    session.dispose();
  });
  it("cancels B for C and ignores late completion", async () => {
    const { session, requests, onReady } = fixture();
    session.lights(lights(1024)); session.lights(lights(2048));
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[0]!.resolve("staged"); await flush(); expect(onReady).not.toHaveBeenCalled();
    requests[1]!.resolve("staged"); await flush(); expect(onReady).toHaveBeenCalledOnce();
    session.dispose();
  });
  it("cancels a staged but unpublished map when another author edit arrives", async () => {
    const { session, requests } = fixture();
    session.lights(lights(2048)); requests[0]!.resolve("staged"); await flush();
    expect(session.lights(lights(4096)).directional?.[0]?.shadow?.mapSize).toBe(512);
    expect(requests[0]!.signal.aborted).toBe(true);
    session.dispose();
  });
  it.each([false, true])("cancels pending on disable/revert (%s)", async revert => {
    const { session, requests, onReady, onFailure } = fixture();
    session.lights(lights(2048)); const source = revert ? lights(512) : lights(2048, false);
    expect(session.lights(source)).toBe(source); expect(requests[0]!.signal.aborted).toBe(true);
    requests[0]!.reject(new Error("late")); await flush();
    expect(onReady).not.toHaveBeenCalled(); expect(onFailure).not.toHaveBeenCalled(); session.dispose();
  });
  it("reports GPU failure and timeout once, preserving cancellation until publication", async () => {
    vi.useFakeTimers(); const { session, requests, onFailure } = fixture();
    session.lights(lights(2048)); requests[0]!.reject(new Error("allocation failed")); await flush();
    expect(onFailure.mock.calls[0]![0].message).toBe("allocation failed");
    session.lights(lights(2048)); await vi.advanceTimersByTimeAsync(30_000);
    expect(onFailure).toHaveBeenCalledTimes(2); expect(requests[1]!.signal.aborted).toBe(true);
    requests[1]!.resolve("staged"); await flush(); expect(onFailure).toHaveBeenCalledTimes(2); session.dispose();
  });
  it("disposes staged resources before an active frame publishes them", async () => {
    const { session, requests } = fixture();
    session.lights(lights(2048)); requests[0]!.resolve("staged"); await flush();
    session.dispose(); expect(requests[0]!.signal.aborted).toBe(true);
    session.lights(lights(4096)); expect(requests).toHaveLength(1);
  });
  it("reports superseded results and onReady errors", async () => {
    const { session, requests, onFailure, onReady } = fixture();
    session.lights(lights(2048)); requests[0]!.resolve("superseded"); await flush();
    expect(onFailure).toHaveBeenCalledOnce();
    onReady.mockImplementation(() => { throw new Error("frame rejected"); });
    session.lights(lights(2048)); requests[1]!.resolve("staged"); await flush();
    expect(onFailure.mock.calls.at(-1)![0].message).toBe("frame rejected"); session.dispose();
  });

  it("cancels staged B on return to A before any submitted frame", async () => {
    const { session, requests, onFailure } = fixture();
    session.lights(lights(2048)); requests[0]!.resolve("staged"); await flush();
    session.acknowledgeMapSize(undefined);
    const original = lights(512);
    expect(session.lights(original)).toBe(original);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests).toHaveLength(1);
    expect(onFailure).not.toHaveBeenCalled();
    session.dispose();
  });

  it("preserves current author pose and parameters while only replacing pending map size", () => {
    const { session, requests } = fixture();
    session.lights(lights(2048));
    const edited = lights(2048);
    const directional = edited.directional![0]!;
    const current = { ...edited, directional: [{ ...directional, intensity: 3, directionWorld: [1, 0, 0] as const,
      shadow: { ...directional.shadow!, bias: -0.01, radius: 5 } }] };
    expect(session.lights(current)).toEqual({ ...current, directional: [{ ...current.directional[0],
      shadow: { ...current.directional[0]!.shadow, mapSize: 512 } }] });
    expect(requests).toHaveLength(1);
    session.dispose();
  });

  it("keeps acknowledged B active while C prepares and ignores absent frame evidence", async () => {
    const { session, requests } = fixture();
    session.lights(lights(2048)); requests[0]!.resolve("staged"); await flush();
    session.acknowledgeMapSize(2048);
    session.acknowledgeMapSize(undefined);
    expect(session.lights(lights(4096)).directional![0]!.shadow!.mapSize).toBe(2048);
    expect(requests[0]!.signal.aborted).toBe(false);
    session.dispose();
    expect(requests[1]!.signal.aborted).toBe(true);
  });
});
