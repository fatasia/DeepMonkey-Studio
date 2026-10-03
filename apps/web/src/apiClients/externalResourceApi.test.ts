import { describe, expect, it, vi } from "vitest";
import { createExternalResourceApi } from "./externalResourceApi";

type OpenExternal = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function openExternalMock(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(input, init));
}

describe("createExternalResourceApi", () => {
  it("rejects non-HTTP(S) addresses and embedded credentials before any request", async () => {
    const openExternal = openExternalMock(async () => jsonResponse({}));
    const api = createExternalResourceApi(() => "https://studio.example.com", openExternal);
    await expect(api.getExternalJson("ftp://cdn.example.com/map.json")).rejects.toThrow("HTTP(S)");
    await expect(api.getExternalJson("https://user:secret@cdn.example.com/map.json")).rejects.toThrow("HTTP(S)");
    await expect(api.downloadExternalModel("javascript:alert(1)")).rejects.toThrow("HTTP(S)");
    await expect(api.downloadExternalModel("http://user@cdn.example.com/model.glb")).rejects.toThrow("HTTP(S)");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("resolves relative addresses against the server profile base URL", async () => {
    const openExternal = openExternalMock(async () => jsonResponse({ type: "FeatureCollection" }));
    const api = createExternalResourceApi(() => "https://studio.example.com/app/", openExternal);
    await api.getExternalJson("/assets/maps/china.json");
    const request = openExternal.mock.calls[0]![0];
    expect(String(request)).toBe("https://studio.example.com/assets/maps/china.json");
  });

  it("maps HTTP failures to readable errors carrying the status code", async () => {
    const api = createExternalResourceApi(
      () => "https://studio.example.com",
      async () => jsonResponse(undefined, false, 503),
    );
    await expect(api.getExternalJson("https://cdn.example.com/map.json")).rejects.toThrow("外部资源 HTTP 503");
    await expect(api.downloadExternalModel("https://cdn.example.com/model.glb")).rejects.toThrow("模型文件读取失败（HTTP 503）");
  });

  it("sends credential-free requests with accept headers and a timeout signal", async () => {
    const openExternal = openExternalMock(async () => jsonResponse({ type: "FeatureCollection" }));
    const api = createExternalResourceApi(() => "https://studio.example.com", openExternal);
    await api.getExternalJson("https://cdn.example.com/map.json");
    const jsonInit = openExternal.mock.calls[0]![1];
    expect(jsonInit?.credentials).toBe("omit");
    expect((jsonInit?.headers as Record<string, string> | undefined)?.accept).toBe("application/json");
    expect(jsonInit?.signal).toBeInstanceOf(AbortSignal);

    const blobResponse = { ok: true, status: 200, blob: async () => new Blob(["glb"]) } as unknown as Response;
    const modelExternal = openExternalMock(async () => blobResponse);
    const modelApi = createExternalResourceApi(() => "https://studio.example.com", modelExternal);
    const blob = await modelApi.downloadExternalModel("https://cdn.example.com/model.glb");
    expect(blob).toBeInstanceOf(Blob);
    const modelInit = modelExternal.mock.calls[0]![1];
    expect(modelInit?.credentials).toBe("omit");
    expect((modelInit?.headers as Record<string, string> | undefined)?.accept).toContain("model/gltf-binary");
  });
});
