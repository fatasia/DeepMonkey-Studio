import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareGpuPacketWork, prepareRenderPacketAsync, type PacketPreparationWorkerHost } from "./packetPreparationAsync.js";
import { assertPacketCloneSafe, buildPacketPreparationWork, preparationTransferables } from "./packetPreparationWork.js";
import { prepareRenderPacket, type RenderPacket } from "./renderPacket.js";

function packet(large = true): RenderPacket {
  const vertices = new Float32Array(large ? 54_000 : 18);
  for (let i = 5; i < vertices.length; i += 6) vertices[i] = 1;
  return { geometries: [{ id: "g", revision: 0, vertices, indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "m", baseColor: [0.1, 0.5, 0.7], metallic: 0.4, roughness: 0.6 }],
    instances: [{ id: "i", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
}
function worker() {
  const host: PacketPreparationWorkerHost = { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() };
  return host;
}
afterEach(() => vi.unstubAllGlobals());
describe("packet CPU worker preparation", () => {
  it("keeps synchronous validator bytes and caller ownership in the Node/small path", async () => {
    const raw = packet(false), expected = prepareRenderPacket(raw);
    expect(await prepareRenderPacketAsync(raw)).toEqual(expected);
    const packed = buildPacketPreparationWork(raw, {}, true);
    expect(packed.geometryBounds!.get("g")!.radius).toBe(1e-6);
    expect(preparationTransferables(packed)).toContain(packed.prepared.geometries.get("g")!.vertices.buffer);
    packed.prepared.geometries.get("g")!.vertices[0] = 2;
    expect(raw.geometries[0]!.vertices[0]).toBe(0);
  });
  it("transports exact owned output without detaching the author's buffers", async () => {
    vi.stubGlobal("Worker", function () {}); const raw = packet(), host = worker();
    const result = prepareGpuPacketWork(raw, {}, undefined, true, () => host);
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledOnce());
    const request = vi.mocked(host.postMessage).mock.calls[0]![0] as { packet: RenderPacket };
    const work = buildPacketPreparationWork(structuredClone(request.packet), {}, true);
    host.onmessage!({ data: { work: structuredClone(work) } });
    const actual = await result;
    expect(actual.prepared).toEqual(prepareRenderPacket(raw));
    expect(actual.geometryInputs.get("g")).toEqual(work.geometryInputs.get("g"));
    expect(raw.geometries[0]!.vertices.byteLength).toBe(216_000);
    expect(host.terminate).toHaveBeenCalledOnce();
  });
  it("terminates cancelled candidates and ignores a late worker response", async () => {
    vi.stubGlobal("Worker", function () {}); const host = worker(), controller = new AbortController();
    const promise = prepareGpuPacketWork(packet(), {}, controller.signal, true, () => host);
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledOnce());
    const late = host.onmessage!;
    const rejected = expect(promise).rejects.toThrow("cancelled"); controller.abort(new Error("cancelled"));
    late({ data: { work: buildPacketPreparationWork(packet(), {}, true) } });
    await rejected; expect(host.terminate).toHaveBeenCalledOnce();
  });
  it("rejects worker/clone failures and cleans up exactly once", async () => {
    vi.stubGlobal("Worker", function () {}); const host = worker();
    vi.mocked(host.postMessage).mockImplementation(() => { throw Error("clone failed"); });
    await expect(prepareGpuPacketWork(packet(), {}, undefined, true, () => host)).rejects.toThrow("clone failed");
    expect(host.terminate).toHaveBeenCalledOnce();
    const next = worker(), result = prepareGpuPacketWork(packet(), {}, undefined, true, () => next);
    await vi.waitFor(() => expect(next.postMessage).toHaveBeenCalledOnce());
    next.onmessage!({ data: { error: "invalid geometry" } });
    await expect(result).rejects.toThrow("invalid geometry"); expect(next.terminate).toHaveBeenCalledOnce();
  });
  it("checks descriptors before structuredClone can execute getters or erase illegal prototypes", async () => {
    vi.stubGlobal("Worker", function () {}); const raw = packet(), getter = vi.fn(() => []), create = vi.fn(worker);
    Object.defineProperty(raw, "materials", { get: getter, enumerable: true });
    await expect(prepareGpuPacketWork(raw, {}, undefined, true, create)).rejects.toThrow("data properties");
    expect(getter).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    const vertexGetter = vi.fn(() => new Float32Array(54_000)), vertexRaw = packet();
    Object.defineProperty(vertexRaw.geometries[0], "vertices", { get: vertexGetter, enumerable: true });
    await expect(prepareGpuPacketWork(vertexRaw, {}, undefined, true, create)).rejects.toThrow("data properties");
    expect(vertexGetter).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(() => assertPacketCloneSafe(Object.create({ injected: true }))).toThrow("plain data");
    expect(() => assertPacketCloneSafe(new Float32Array(new SharedArrayBuffer(4)))).toThrow("unshared");
  });
});
