import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";
import { auditConverterOutput } from "./converterOutputAudit.js";
import { convertJtLod0ToGlb } from "./jtGlbConverter.js";
import { writeJtInspectionArtifacts } from "./jtInspection.js";

const directories: string[] = [];
const fixturePath = fileURLToPath(new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-coffee-maker-jt9.5.jt",
  import.meta.url,
));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JT multi-mesh GLB adapter", () => {
  it("combines every decoded JT 9.5 LOD0 mesh without inventing assembly ownership", async () => {
    await expect(readFile(fixturePath)).resolves.not.toHaveLength(0);
    const outputDir = await mkdtemp(path.join(tmpdir(), "bim-jt95-glb-"));
    directories.push(outputDir);
    const artifacts = await writeJtInspectionArtifacts(fixturePath, outputDir);
    const result = await convertJtLod0ToGlb(
      artifacts.document,
      outputDir,
      "coffee-maker.jt",
      artifacts.inspection.materials,
    );

    expect(artifacts.inspection.geometry).toMatchObject({
      status: "decoded",
      meshCount: 44,
      lod0MeshCount: 44,
      lod0InstanceCount: 64,
      vertexCount: 23_999,
      triangleCount: 47_962,
    });
    expect(result).toMatchObject({ meshCount: 44, instanceCount: 64, vertexCount: 23_999, triangleCount: 47_962 });
    expect(result?.bounds.min.every(Number.isFinite)).toBe(true);
    expect(result?.bounds.max.every(Number.isFinite)).toBe(true);
    expect(await auditConverterOutput(outputDir, true)).toMatchObject({
      geometry: { meshCount: 45, triangleCount: 50_194 },
    });
    const glb = await new NodeIO().read(path.join(outputDir, "geometry.glb"));
    const meshNodes = glb.getRoot().listNodes().filter((node) => node.getMesh());
    expect(meshNodes).toHaveLength(64);
    expect(new Set(meshNodes.map((node) => node.getMesh())).size).toBe(45);
    const evidenceById = new Map(artifacts.inspection.materials.map((m) => [m.objectId, m]));
    for (const node of meshNodes) {
      const extras = node.getExtras();
      const owners = (String(extras.AssemblyPath).split("/").map(Number)).filter((id) => evidenceById.has(id));
      expect(owners).toHaveLength(1);
      expect(extras).toMatchObject({ MaterialStatus: "source-path", MaterialSourceObjectIds: owners });
      const source = evidenceById.get(owners[0]!)!;
      for (const primitive of node.getMesh()!.listPrimitives()) {
        expect(primitive.getMaterial()!.getBaseColorFactor()).toEqual([...source.diffuse, source.opacity]);
      }
    }
    const silver = meshNodes.find((n) => String(n.getExtras().AssemblyPath).includes("/18/184/"))!.getMesh()!;
    const gray = meshNodes.find((n) => String(n.getExtras().AssemblyPath).includes("/43/184/"))!.getMesh()!;
    expect(silver).not.toBe(gray);
    expect(silver.listPrimitives()).toHaveLength(gray.listPrimitives().length);
    silver.listPrimitives().forEach((primitive, index) => {
      const other = gray.listPrimitives()[index]!;
      expect(primitive.getAttribute("POSITION")).toBe(other.getAttribute("POSITION"));
      expect(primitive.getAttribute("NORMAL")).toBe(other.getAttribute("NORMAL"));
      expect(primitive.getIndices()).toBe(other.getIndices());
    });
    expect(meshNodes.some((node) => node.getMatrix().some((value, index) => value !== IDENTITY[index]))).toBe(true);
    const hierarchy = JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8")) as {
      root: { meshIds: string[] };
    };
    expect(hierarchy.root.meshIds).toHaveLength(64);
  });
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
