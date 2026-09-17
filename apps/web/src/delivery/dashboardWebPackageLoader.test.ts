import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { loadDashboardWebPackage } from "./dashboardWebPackageLoader";

const base = new URL("https://static.invalid/nested/package/");
const payload = new Uint8Array([1, 2, 3]);
function manifest() {
  const application = structuredClone(fixture.application);
  application.scripts = []; application.scenes = []; application.interactions = [];
  application.pages = application.pages.slice(0, 1); application.pages[0]!.nodes = [];
  const publication = { id: "published", applicationId: application.metadata.id,
    projectId: application.metadata.projectId, applicationRevision: application.metadata.revision,
    document: application, publishedAt: "2026-09-17T00:00:00Z" };
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const body = { schema: "deep-monkey.dashboard-web", schemaVersion: 1, publication,
    publicationSha256: runtimeContentSha256(publication), entryPageId: application.pages[0]!.id,
    runtimeFiles: [{ path: "assets/license.txt", bytes: payload.length, sha256 }],
    resources: [400, 700].map(weight => ({ sourceUrl: `font:${weight}`, path: `resources/font-${weight}`,
      mime: "font/ttf", bytes: payload.length, sha256,
      font: { weight, style: "normal", licenseEvidence: "test identity only", licensePath: "assets/license.txt" } })) };
  return { ...body, contentSha256: runtimeContentSha256(body) };
}
function transport(resource: (url: URL) => Response) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    return url.pathname.endsWith("dashboard.web.json")
      ? new Response(JSON.stringify(manifest())) : resource(url);
  });
}

describe("static package transport boundaries", () => {
  it("omits credentials, refuses redirects and retains subdirectory paths", async () => {
    const fetcher = transport(() => new Response(payload));
    const signal = new AbortController().signal;
    await loadDashboardWebPackage(base, signal, fetcher as typeof fetch);
    for (const call of fetcher.mock.calls as unknown as [URL, RequestInit][]) {
      expect(call[0].href.startsWith(base.href)).toBe(true);
      expect(call[1]).toEqual({ signal, credentials: "omit", cache: "no-store", redirect: "error" });
    }
  });
  it("cancels an oversized stream before requesting any later file", async () => {
    const cancel = vi.fn();
    const fetcher = transport(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4)); }, cancel,
    })));
    await expect(loadDashboardWebPackage(base, new AbortController().signal, fetcher as typeof fetch))
      .rejects.toThrow(/预算/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects a truncated final resource even when the stream closes normally", async () => {
    const fetcher = transport(url => new Response(url.pathname.endsWith("font-700") ? payload.slice(0, 2) : payload));
    await expect(loadDashboardWebPackage(base, new AbortController().signal, fetcher as typeof fetch))
      .rejects.toThrow(/校验失败/);
  });
  it("does not publish a completed package if cancellation arrives with the last EOF", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled at final EOF");
    const fetcher = transport(url => {
      if (!url.pathname.endsWith("font-700")) return new Response(payload);
      let delivered = false;
      return new Response(new ReadableStream({ pull(stream) {
        if (!delivered) { delivered = true; stream.enqueue(payload); }
        else { controller.abort(reason); stream.close(); }
      } }, { highWaterMark: 0 }));
    });
    await expect(loadDashboardWebPackage(base, controller.signal, fetcher as typeof fetch)).rejects.toBe(reason);
  });
  it("rejects malformed UTF-8 before parsing or requesting resources", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([0xff])));
    await expect(loadDashboardWebPackage(base, new AbortController().signal, fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("refuses a package root without a trailing slash before any request", async () => {
    const fetcher = vi.fn();
    await expect(loadDashboardWebPackage(new URL("https://static.invalid/nested/package"),
      new AbortController().signal, fetcher as typeof fetch)).rejects.toThrow(/\/ 结尾/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
