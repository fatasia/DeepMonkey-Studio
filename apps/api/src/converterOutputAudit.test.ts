import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";
import { auditConverterOutput, auditGlbGeometry } from "./converterOutputAudit.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("converter output audit", () => {
  it("accepts valid indexed geometry and reports exact triangle counts", async () => {
    const file = await writeGeometry();
    await expect(auditGlbGeometry(file)).resolves.toEqual({ meshCount: 1, primitiveCount: 1, vertexCount: 3, triangleCount: 1 });
  });

  it.each([
    { indices: [0, 1, 3], message: "超出 POSITION" },
    { indices: [0, 1, 2, 0], message: "3 倍数" },
    { indices: [], message: "3 倍数" },
  ])("rejects invalid triangle indices $indices", async ({ indices, message }) => {
    const file = await writeGeometry({ indices });
    await expect(auditGlbGeometry(file)).rejects.toThrow(message);
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-finite coordinate %s", async (coordinate) => {
    const file = await writeGeometry({ coordinate });
    await expect(auditGlbGeometry(file)).rejects.toThrow("非有限坐标");
  });

  it.each([5, 6] as const)("rejects truncated strip/fan mode %s", async (mode) => {
    const file = await writeGeometry({ indices: [0, 1], mode });
    await expect(auditGlbGeometry(file)).rejects.toThrow("至少需要 3 个元素");
  });

  it("rejects a corrupt hierarchy sidecar before an industrial GLB is published", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "bim-output-audit-"));
    directories.push(outputDir);
    await writeFile(path.join(outputDir, "geometry.glb"), await triangleGlb());
    await writeFile(path.join(outputDir, "hierarchy.json"), "[", "utf8");

    await expect(auditConverterOutput(outputDir, true)).rejects.toThrow("hierarchy.json 审计失败");
  });
});

type GeometryOptions = { indices?: number[]; coordinate?: number; mode?: 4 | 5 | 6 };

async function writeGeometry(options: GeometryOptions = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-output-geometry-"));
  directories.push(directory);
  const file = path.join(directory, "geometry.glb");
  await writeFile(file, await triangleGlb(options));
  return file;
}

async function triangleGlb(options: GeometryOptions = {}): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer("test");
  const positions = document.createAccessor().setType(Accessor.Type.VEC3).setBuffer(buffer)
    .setArray(new Float32Array([options.coordinate ?? 0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const indices = document.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer)
    .setArray(new Uint16Array(options.indices ?? [0, 1, 2]));
  const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices).setMode(options.mode ?? 4);
  const mesh = document.createMesh("triangle").addPrimitive(primitive);
  document.createScene("test").addChild(document.createNode("triangle").setMesh(mesh));
  return new NodeIO().writeBinary(document);
}
