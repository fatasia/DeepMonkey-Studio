import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConverterExecutionContext } from "./conversionTasks.js";
import type { ObjectStore } from "./objects.js";
import { attemptObjects } from "./modelConversionAdapter.js";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-attempt-boundary-")); directories.push(directory);
  const attempt = path.join(directory, "attempt"); const outside = path.join(directory, "outside");
  await mkdir(attempt); await mkdir(outside); await writeFile(path.join(attempt, "manifest.json"), '{"value":"draft"}');
  await writeFile(path.join(outside, "private.json"), '{"private":true}');
  const putFile = vi.fn(async () => {}); const controller = new AbortController();
  const prefix = "projects/p/models/m"; const target = `${prefix}/attempts/t`;
  const objects = await attemptObjects({ putFile } as unknown as ObjectStore, { signal: controller.signal } as ConverterExecutionContext,
    prefix, target, attempt, value => ({ ...value as object, remapped: true }));
  return { directory, attempt, outside, putFile, controller, prefix, target, objects };
}
describe("conversion attempt object boundary", () => {
  it("writes the manifest through the guarded immutable attempt prefix", async () => {
    const f = await fixture(); const file = path.join(f.attempt, "manifest.json");
    await f.objects.putFile(`${f.prefix}/manifest.json`, file);
    expect(f.putFile).toHaveBeenCalledExactlyOnceWith(`${f.target}/manifest.json`, file);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ value: "draft", remapped: true });
  });
  it.each(["../private.json", "output/../../private.json", "output//private.json", "output/./private.json", "output\\private.json", "source/private.json"])("rejects object key escape %s before writing", async suffix => {
    const f = await fixture();
    await expect(f.objects.putFile(`${f.prefix}/${suffix}`, path.join(f.attempt, "manifest.json"))).rejects.toThrow();
    expect(f.putFile).not.toHaveBeenCalled();
  });
  it("rejects mismatched object keys and direct paths outside the attempt", async () => {
    const f = await fixture();
    await expect(f.objects.putFile(`${f.prefix}/wrong.json`, path.join(f.attempt, "manifest.json"))).rejects.toThrow("不一致");
    await expect(f.objects.putFile(`${f.prefix}/private.json`, path.join(f.outside, "private.json"))).rejects.toThrow("attempt");
    expect(f.putFile).not.toHaveBeenCalled();
  });
  it("rejects a real Windows junction (or directory symlink) to data outside the attempt", async () => {
    const f = await fixture(); const linked = path.join(f.attempt, "linked");
    await symlink(f.outside, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(f.objects.putFile(`${f.prefix}/linked/private.json`, path.join(linked, "private.json"))).rejects.toThrow("真实路径越界");
    await expect(f.objects.syncDirectory(f.prefix, f.attempt)).rejects.toThrow("符号链接");
    expect(f.putFile).not.toHaveBeenCalled();
  });
  it("does not rewrite or upload a manifest after cancellation", async () => {
    const f = await fixture(); f.controller.abort(new Error("cancelled"));
    await expect(f.objects.putFile(`${f.prefix}/manifest.json`, path.join(f.attempt, "manifest.json"))).rejects.toThrow("cancelled");
    expect(JSON.parse(await readFile(path.join(f.attempt, "manifest.json"), "utf8"))).toEqual({ value: "draft" });
    expect(f.putFile).not.toHaveBeenCalled();
  });
});
