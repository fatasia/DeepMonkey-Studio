import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardWebStaticDeployment, isDashboardWebStaticDeploymentConfig } from "./dashboardWebStaticDeployment.js";
import { createWebStaticFixture, webAuthority, IMAGE_KEY } from "./dashboardWebStaticPackage.testUtils.js";
import type { DashboardNativeCandidateRecord } from "./dashboardNativeCandidateRegistry.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const record = { candidate: { authority: webAuthority } } as DashboardNativeCandidateRecord;
async function fixture() {
  const f = await createWebStaticFixture(); cleanup.push(f.directory);
  const getPublishedApplication = vi.fn(() => structuredClone(f.publication));
  const read = vi.fn(async () => ({ stream: Readable.from([f.objects.get(IMAGE_KEY)!]), completed: Promise.resolve() }));
  const config = { root: f.webStaticRoot, licensedFonts: f.licensedFonts };
  const deployment = await createDashboardWebStaticDeployment(config, { getPublishedApplication }, { read } as never);
  return { ...f, config, deployment, getPublishedApplication, read };
}

describe("Dashboard Web static deployment", () => {
  it("binds the frozen publication and streams resources through the existing object store", async () => {
    const f = await fixture();
    const publication = await f.deployment.readPublication({ record });
    expect(publication).toEqual(f.publication);
    expect(f.getPublishedApplication).toHaveBeenCalledWith(webAuthority.publicationId);
    expect(await f.deployment.readResourceObject(IMAGE_KEY)).toEqual(f.objects.get(IMAGE_KEY));
    expect(f.read).toHaveBeenCalledWith(IMAGE_KEY);
    expect(f.deployment.licensedFonts).not.toBe(f.config.licensedFonts);
  });
  it.each(["projectId", "applicationId", "applicationRevision"] as const)("rejects mismatched %s", async key => {
    const f = await fixture();
    f.getPublishedApplication.mockReturnValue({ ...f.publication, [key]: key === "applicationRevision" ? 999 : "other" });
    expect(await f.deployment.readPublication({ record })).toBeUndefined();
  });
  it("rejects cancellation before reading publication or object storage", async () => {
    const f = await fixture(), signal = AbortSignal.abort(new Error("cancelled"));
    await expect(f.deployment.readPublication({ record, signal })).rejects.toThrow("cancelled");
    await expect(f.deployment.readResourceObject(IMAGE_KEY, signal)).rejects.toThrow("cancelled");
    expect(f.getPublishedApplication).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("fails startup when the static runtime is not built", async () => {
    const f = await fixture();
    await rm(path.join(f.webStaticRoot, "index.html"));
    await expect(createDashboardWebStaticDeployment(f.config, { getPublishedApplication: f.getPublishedApplication }, { read: f.read } as never))
      .rejects.toThrow();
  });
  it.each([null, [], {}, { root: "relative", licensedFonts: [] },
    { root: path.resolve("dist"), licensedFonts: [null] },
    { root: path.resolve("dist"), licensedFonts: [{ path: "relative", licensePath: "relative" }] }])("rejects malformed configuration: %j", value => {
    expect(isDashboardWebStaticDeploymentConfig(value)).toBe(false);
  });
});
