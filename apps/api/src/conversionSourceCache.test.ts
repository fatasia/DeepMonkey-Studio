import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversionTaskRecord } from "@bim-studio/contracts";
import type { ObjectStore } from "./objects.js";
import { verifyConversionSource } from "./conversionSourceCache.js";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(content = Buffer.from("authoritative source")) {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-source-cache-")); directories.push(directory);
  const destination = path.join(directory, "source.jt");
  const task = { id: "task-1", input: { objectKey: "projects/p/source.jt", size: content.length,
    sha256: createHash("sha256").update(content).digest("hex") } } as ConversionTaskRecord;
  const read = vi.fn(async () => ({ stream: Readable.from([content]), completed: Promise.resolve() }));
  return { directory, destination, task, content, read, objects: { read } as unknown as ObjectStore };
}
describe("authoritative source cache recovery", () => {
  it("materializes a missing local source from object storage after hash verification", async () => {
    const f = await fixture();
    await verifyConversionSource(f.objects, f.task, f.destination, new AbortController().signal);
    expect(await readFile(f.destination)).toEqual(f.content);
    expect(f.read).toHaveBeenCalledWith(f.task.input.objectKey);
    await expect(readFile(path.join(f.directory, ".restore-task-1"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("verifies an existing cache without downloading again", async () => {
    const f = await fixture(); await writeFile(f.destination, f.content);
    await verifyConversionSource(f.objects, f.task, f.destination, new AbortController().signal);
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["truncated", "oversized", "wrong-hash"])("does not install %s bytes", async fault => {
    const f = await fixture(); const bytes = fault === "truncated" ? f.content.subarray(1) : fault === "oversized" ? Buffer.concat([f.content, Buffer.from("extra")]) : Buffer.alloc(f.content.length, 1);
    f.read.mockResolvedValue({ stream: Readable.from([bytes]), completed: Promise.resolve() });
    await expect(verifyConversionSource(f.objects, f.task, f.destination, new AbortController().signal)).rejects.toThrow();
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(f.directory, ".restore-task-1"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("propagates an object process failure even if the stream completed", async () => {
    const f = await fixture();
    f.read.mockImplementation(async () => ({ stream: Readable.from([f.content]), completed: Promise.reject(new Error("object process failed")) }));
    await expect(verifyConversionSource(f.objects, f.task, f.destination, new AbortController().signal)).rejects.toThrow("object process failed");
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not download after cancellation", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(verifyConversionSource(f.objects, f.task, f.destination, controller.signal)).rejects.toThrow("cancelled");
    expect(f.read).not.toHaveBeenCalled();
  });
});
