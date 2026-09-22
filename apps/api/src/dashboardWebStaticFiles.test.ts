import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DASHBOARD_WEB_FILE_LIMIT } from "@bim-studio/contracts";
import { collectDashboardStaticFiles, readDashboardStaticFile } from "./dashboardWebStaticFiles.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-static-files-")); directories.push(directory);
  const root = path.join(directory, "runtime"); await mkdir(root);
  await writeFile(path.join(root, "index.html"), "<!doctype html>");
  return { directory, root };
}

describe("Dashboard static file closure", () => {
  it("collects files in deterministic order while excluding generated manifests/licenses", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "z.js"), "z"); await writeFile(path.join(root, "a.js"), "a");
    await mkdir(path.join(root, "licenses")); await writeFile(path.join(root, "licenses", "unused.txt"), "unused");
    await writeFile(path.join(root, "dashboard.web.json"), "stale");
    expect((await collectDashboardStaticFiles(root)).map(file => file.path)).toEqual(["a.js", "index.html", "z.js"]);
  });
  it("rejects directory junctions outside the runtime before collecting their content", async () => {
    const { root, directory } = await fixture(), external = path.join(directory, "external");
    await mkdir(external); await writeFile(path.join(external, "outside.js"), "outside");
    await symlink(external, path.join(root, "escape"), "junction");
    await expect(collectDashboardStaticFiles(root)).rejects.toThrow(/越界|链接/);
  });
  it("rejects oversized files before allocating their body", async () => {
    const { root } = await fixture(), file = path.join(root, "oversized.bin");
    await writeFile(file, ""); await truncate(file, DASHBOARD_WEB_FILE_LIMIT + 1);
    await expect(collectDashboardStaticFiles(root)).rejects.toThrow(/预算/);
  });
  it("uses a bounded snapshot and honors cancellation", async () => {
    const { root } = await fixture(), file = path.join(root, "index.html");
    expect((await readDashboardStaticFile(file, 1024)).toString()).toBe("<!doctype html>");
    await expect(readDashboardStaticFile(file, 2)).rejects.toThrow(/预算/);
    await expect(readDashboardStaticFile(file, 1024, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    await expect(collectDashboardStaticFiles(root, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
  });
});
