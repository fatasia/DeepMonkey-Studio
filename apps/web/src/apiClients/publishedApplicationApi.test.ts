import { describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { createPublishedApplicationApi } from "./publishedApplicationApi";

describe("public application client", () => {
  it("omits credentials and fetches exact publication dependencies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("export const n=42;"));
    const api = createPublishedApplicationApi("https://test.invalid", fetcher);
    expect(await api.dependency("a", "v2", "dep")).toContain("42");
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://test.invalid/api/public/applications/a/revisions/v2/dependencies/dep");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(fetcher.mock.calls[0]![1]?.headers).toBeUndefined();
  });
  it("reports withdrawn and temporary failures without dumping service internals", async () => {
    for (const status of [404, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private details", { status }));
      await expect(createPublishedApplicationApi("https://test.invalid", fetcher).browse("a")).rejects.toThrow(status === 404 ? "已撤回" : "503");
    }
  });
  it("rejects a document paired with another project", async () => {
    const document = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ publication: { applicationId: "a", projectId: "p", document }, project: { id: "wrong", models: [] } }));
    await expect(createPublishedApplicationApi("https://test.invalid", fetcher).browse("a")).rejects.toThrow("不匹配");
  });
});
