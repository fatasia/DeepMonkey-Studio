import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRobotSource } from "./prepareRobotSource.js";
import { inspectRobotZipDirectory } from "./robotZipDirectory.js";

const simple = '<robot name="fixture"><link name="base"/></robot>';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) {
  if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("bim-robot-source-")) throw new Error("invalid test directory");
  await rm(directory, { recursive: true, force: true });
} });
async function fixture(bytes: Buffer | string, name = "robot.zip") {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-robot-source-")); directories.push(directory);
  const file = path.join(directory, name); await writeFile(file, bytes); return file;
}
async function archive(files: Record<string, string | Buffer>, compression: "STORE" | "DEFLATE" = "DEFLATE") {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes, { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression });
}
function central(bytes: Buffer) { return bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); }

describe("robot source package", () => {
  it("preserves standalone XML bytes and includes their SHA-256 evidence", async () => {
    const file = await fixture(simple, "robot.urdf");
    const result = await prepareRobotSource(file);
    expect(result.entryPath).toBe("robot.urdf");
    expect(result.resources).toEqual([{ path: "robot.urdf", size: Buffer.byteLength(simple), sha256: createHash("sha256").update(simple).digest("hex") }]);
    expect(await readFile(file, "utf8")).toBe(simple);
    await expect(prepareRobotSource(file, { entryPath: "other.urdf" })).rejects.toThrow("入口");
  });
  it("retains every package resource, material and a nested relative mesh without extracting to disk", async () => {
    const xml = '<robot name="fixture"><link name="base"><visual><geometry><mesh filename="../meshes/base.stl"/></geometry></visual></link></robot>';
    const bytes = await archive({ "pkg/urdf/main.urdf": xml, "pkg/meshes/base.stl": "solid base\nendsolid", "README.txt": "source credit" });
    const file = await fixture(bytes); const result = await prepareRobotSource(file);
    expect(result.resources.map(item => item.path).sort()).toEqual(["README.txt", "pkg/meshes/base.stl", "pkg/urdf/main.urdf"]);
    expect(result.links[0]!.visuals[0]!.geometry).toMatchObject({ resolvedPath: "pkg/meshes/base.stl" });
    expect(await readFile(file)).toEqual(bytes);
  });
  it("requires a selected entry for multiple URDFs and rejects missing/nonrobot entries", async () => {
    const file = await fixture(await archive({ "a.urdf": simple, "b.urdf": simple }));
    await expect(prepareRobotSource(file)).rejects.toThrow("多个 URDF");
    expect((await prepareRobotSource(file, { entryPath: "b.urdf" })).entryPath).toBe("b.urdf");
    await expect(prepareRobotSource(file, { entryPath: "missing.urdf" })).rejects.toThrow();
    await expect(prepareRobotSource(await fixture(await archive({ "mesh.stl": "solid" })))).rejects.toThrow("缺少");
  });
  it.each(["../robot.urdf", "/robot.urdf", "C:/robot.urdf", "a\\robot.urdf", "__proto__/robot.urdf", "ｒobot.urdf", "%2e%2e/robot.urdf", "a%2frobot.urdf", "%252e%252e/robot.urdf"]) ("rejects unsafe archive path %s before JSZip sanitization", async name => {
    await expect(prepareRobotSource(await fixture(await archive({ [name]: simple })))).rejects.toThrow();
  });
  it("rejects duplicate paths including case-folded aliases", async () => {
    await expect(prepareRobotSource(await fixture(await archive({ "robot.urdf": simple, "ROBOT.urdf": simple })))).rejects.toThrow("重复");
    const bytes = await archive({ "a.urdf": simple, "b.urdf": simple }, "STORE");
    for (let offset = 0; offset < bytes.length - 6; offset++) if (bytes.subarray(offset, offset + 6).toString() === "b.urdf") bytes.write("a.urdf", offset);
    expect(() => inspectRobotZipDirectory(bytes)).toThrow("重复");
  });
  it("rejects encrypted, symlink, ZIP64, oversized and high-inflation entries", async () => {
    const original = await archive({ "robot.urdf": simple }, "STORE"); const offset = central(original);
    for (const mutate of [
      (bytes: Buffer) => bytes.writeUInt16LE(1, offset + 8),
      (bytes: Buffer) => bytes.writeUInt32LE((0xa1ff * 65536) >>> 0, offset + 38),
      (bytes: Buffer) => bytes.writeUInt32LE(0xffffffff, offset + 24),
      (bytes: Buffer) => bytes.writeUInt32LE(65 * 1024 * 1024, offset + 24),
    ]) { const bytes = Buffer.from(original); mutate(bytes); expect(() => inspectRobotZipDirectory(bytes)).toThrow(); }
    const bomb = await archive({ "robot.urdf": simple, "huge.bin": Buffer.alloc(2 * 1024 * 1024) });
    expect(() => inspectRobotZipDirectory(bomb)).toThrow("压缩比例");
  });
  it("rejects inconsistent CRC, metadata lengths and invalid UTF-8", async () => {
    const original = await archive({ "robot.urdf": simple }, "STORE"); const offset = central(original);
    const crc = Buffer.from(original); crc[30 + crc.readUInt16LE(26) + crc.readUInt16LE(28)]! ^= 1;
    await expect(prepareRobotSource(await fixture(crc))).rejects.toThrow("校验");
    const size = Buffer.from(original); size.writeUInt32LE(1, offset + 24);
    await expect(prepareRobotSource(await fixture(size))).rejects.toThrow();
    await expect(prepareRobotSource(await fixture(Buffer.from([255, 254]), "robot.urdf"))).rejects.toThrow("UTF-8");
  });
  it("rejects entry-count and expanded-size budgets using metadata without inflating payloads", async () => {
    const original = await archive({ "robot.urdf": simple }, "STORE");
    const count = Buffer.from(original); count.writeUInt16LE(2049, count.length - 14); count.writeUInt16LE(2049, count.length - 12);
    expect(() => inspectRobotZipDirectory(count)).toThrow("文件数");
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`item${index}.bin`, Buffer.alloc(340000)]));
    const expanded = await archive(files, "STORE");
    let offset = central(expanded);
    for (let index = 0; index < 5; index++) {
      const local = expanded.readUInt32LE(offset + 42);
      expanded.writeUInt32LE(64 * 1024 * 1024, offset + 24); expanded.writeUInt32LE(64 * 1024 * 1024, local + 22);
      offset += 46 + expanded.readUInt16LE(offset + 28) + expanded.readUInt16LE(offset + 30) + expanded.readUInt16LE(offset + 32);
    }
    expect(() => inspectRobotZipDirectory(expanded)).toThrow("256 MiB");
  });
  it("does not retrieve remote mesh or entity resources", async () => {
    for (const xml of ['<!DOCTYPE robot [<!ENTITY secret SYSTEM "http://example.com/private">]><robot name="x"><link name="a"/></robot>', '<robot name="x"><link name="a"><visual><geometry><mesh filename="https://example.com/a.stl"/></geometry></visual></link></robot>']) {
      await expect(prepareRobotSource(await fixture(await archive({ "robot.urdf": xml })))).rejects.toThrow();
    }
  });
});
