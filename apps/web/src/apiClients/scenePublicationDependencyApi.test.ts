import { expect, it, vi } from "vitest";
import { createScenePublicationDependencyApi } from "./scenePublicationDependencyApi";
import type { SceneSnapshot } from "@bim-studio/contracts";
const url = `/api/projects/p/scenes/s/publications/1/dependencies/resources/${"a".repeat(64)}`;
it("downloads an exact published Scene EXE with bounded authenticated POST", async () => {
 const open = vi.fn().mockResolvedValue(new Response(new Uint8Array(64), { headers: { "content-length": "64" } }));
 const api = createScenePublicationDependencyApi(vi.fn(), open), controller = new AbortController();
 const blob = await api.downloadSceneExecutable("p/a", "s b", 3, controller.signal, { applicationName: "Client" });
 expect(blob.size).toBe(64); expect(open.mock.lastCall![0]).toBe("/api/projects/p%2Fa/scenes/s%20b/publications/3/native-executable");
 expect(JSON.parse(open.mock.lastCall![1].body)).toEqual({ branding: { applicationName: "Client" } });
 controller.abort(); expect(open.mock.lastCall![1].signal.aborted).toBe(true);
});
it.each([undefined, "0", "65", "9999999999"])("rejects missing or inconsistent EXE length %s", async length => {
 const open = vi.fn().mockResolvedValue(new Response(new Uint8Array(64), { headers: length ? { "content-length": length } : {} }));
 const api = createScenePublicationDependencyApi(vi.fn(), open);
 await expect(api.downloadSceneExecutable("p", "s", 1, new AbortController().signal)).rejects.toThrow();
});
it("preserves server branding rejection and does not prepare another candidate", async () => {
 const open = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "图标像素损坏" }), { status: 400 }));
 const request = vi.fn(), api = createScenePublicationDependencyApi(request, open);
 await expect(api.downloadSceneExecutable("p", "s", 1, new AbortController().signal)).rejects.toThrow("图标像素损坏");
 expect(request).not.toHaveBeenCalled();
});
it("creates a Native candidate through authenticated POST with the exact saved snapshot", async () => {
 const result = { status: "blocked", report: { reason: "test" } };
 const request = vi.fn().mockResolvedValue(result); const api = createScenePublicationDependencyApi(request, vi.fn());
 const snapshot = { id: "s b", projectId: "p/a", name: "saved" } as SceneSnapshot;
 const pending = api.createNativeSceneCandidate("p/a", "s b", snapshot);
 snapshot.name = "later draft";
 expect(await pending).toBe(result);
 expect(request).toHaveBeenCalledExactlyOnceWith("/api/projects/p%2Fa/scenes/s%20b/native-candidates", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedSnapshot: { id: "s b", projectId: "p/a", name: "saved" } }),
 });
});
it.each(["503 unconfigured", "409 snapshot changed"])("preserves Native candidate transport error %s", async message => {
 const error = new Error(message); const request = vi.fn().mockRejectedValue(error);
 const api = createScenePublicationDependencyApi(request, vi.fn());
 await expect(api.createNativeSceneCandidate("p", "s", {} as SceneSnapshot)).rejects.toBe(error);
});
it("passes protected requests through supplied authenticated transport and preserves cancellation", async () => {
 const request = vi.fn().mockResolvedValue({}); const open = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2])));
 const api = createScenePublicationDependencyApi(request, open); const controller = new AbortController();
 await api.getScenePublicationDependencies("p/a", "s b", 2, controller.signal);
 expect(request).toHaveBeenCalledWith("/api/projects/p%2Fa/scenes/s%20b/publications/2/dependencies", { signal: controller.signal });
 expect(new Uint8Array(await api.loadScenePublicationResource(url, 2, controller.signal))).toEqual(new Uint8Array([1, 2]));
 expect(open.mock.lastCall![0]).toBe(url); expect(Object.keys(open.mock.lastCall![1])).toEqual(["signal"]);
 controller.abort(); expect(open.mock.lastCall![1].signal.aborted).toBe(true);
});
it.each([0, 1, 3])("rejects actual byte size 2 versus declared %s", async bytes => {
 const api = createScenePublicationDependencyApi(vi.fn(), vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]))));
 await expect(api.loadScenePublicationResource(url, bytes, new AbortController().signal)).rejects.toThrow();
});
it("propagates 401 from the authenticated transport", async () => {
 const open = vi.fn().mockRejectedValue(new Error("401 unauthorized")); const api = createScenePublicationDependencyApi(vi.fn(), open);
 await expect(api.loadScenePublicationResource(url, 2, new AbortController().signal)).rejects.toThrow("401");
});
it.each(["https://other.test/blob", "/assets/private", url.replace("/1/", "/0/")])("rejects unsafe URL %s before opening", async bad => {
 const open = vi.fn(); const api = createScenePublicationDependencyApi(vi.fn(), open);
 await expect(api.loadScenePublicationResource(bad, 2, new AbortController().signal)).rejects.toThrow(); expect(open).not.toHaveBeenCalled();
});
it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])("rejects invalid byte limit %s", async bytes => {
 const open = vi.fn(); const api = createScenePublicationDependencyApi(vi.fn(), open);
 await expect(api.loadScenePublicationResource(url, bytes, new AbortController().signal)).rejects.toThrow(); expect(open).not.toHaveBeenCalled();
});
it("cancels the reader when caller aborts during streaming", async () => {
 const controller = new AbortController(); const cancel = vi.fn();
 const body = new ReadableStream<Uint8Array>({ pull(stream) { controller.abort(); stream.enqueue(new Uint8Array([1])); }, cancel });
 const api = createScenePublicationDependencyApi(vi.fn(), vi.fn().mockResolvedValue(new Response(body)));
 await expect(api.loadScenePublicationResource(url, 2, controller.signal)).rejects.toThrow(); expect(cancel).toHaveBeenCalled();
});
