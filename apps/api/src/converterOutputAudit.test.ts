import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";
import { auditConverterOutput } from "./converterOutputAudit.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("converter output audit", () => {
  it("rejects a corrupt hierarchy sidecar before an industrial GLB is published", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "bim-output-audit-"));
    directories.push(outputDir);
    await writeFile(path.join(outputDir, "geometry.glb"), await triangleGlb());
    await writeFile(path.join(outputDir, "hierarchy.json"), "[", "utf8");

    await expect(auditConverterOutput(outputDir, true)).rejects.toThrow("hierarchy.json 审计失败");
  });
});

async function triangleGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer("test");
  const positions = document.createAccessor().setType(Accessor.Type.VEC3).setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const indices = document.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2]));
  const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices);
  const mesh = document.createMesh("triangle").addPrimitive(primitive);
  document.createScene("test").addChild(document.createNode("triangle").setMesh(mesh));
  return new NodeIO().writeBinary(document);
}
