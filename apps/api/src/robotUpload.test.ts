import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { writeRobotUpload } from "./robotUpload.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) {
  if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("bim-robot-stream-")) throw new Error("invalid test directory");
  await rm(directory, { recursive: true, force: true });
} });
async function file() { const directory = await mkdtemp(path.join(tmpdir(), "bim-robot-stream-")); directories.push(directory); return path.join(directory, "robot.zip"); }

describe("bounded robot upload", () => {
  it("does not overwrite or delete an existing source path", async () => {
    const target = await file(); await writeFile(target, "existing");
    await expect(writeRobotUpload(Readable.from(["new"]), target, "zip")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("existing");
  });
  it("caps ZIP compressed bytes incrementally and removes its own partial upload", async () => {
    const target = await file(); const chunk = Buffer.alloc(1024 * 1024);
    async function* bytes() { for (let index = 0; index < 129; index++) yield chunk; }
    await expect(writeRobotUpload(Readable.from(bytes()), target, "zip")).rejects.toThrow("128 MiB");
    await expect(stat(target)).rejects.toThrow();
  });
  it("cleans a cancelled input without retaining a partial source", async () => {
    const target = await file();
    async function* bytes() { yield Buffer.from("partial"); throw new Error("cancelled input"); }
    await expect(writeRobotUpload(Readable.from(bytes()), target, "urdf")).rejects.toThrow("cancelled");
    await expect(stat(target)).rejects.toThrow();
  });
});
