import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
const exampleBlockFixturePath = fileURLToPath(new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-example-block-jt10.3.jt",
  import.meta.url,
));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(!existsSync(fixturePath))("JT multi-mesh GLB adapter [skipped: external fixture pack unavailable]", () => {
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
    // 真实样本无 UV/Color binding(字节证据见 packages/jt-reader/src/index.test.ts):
    // 转换器必须如实上报未解码,且 GLB 中不出现这两个 accessor。
    expect(result?.decodedAttributes).toEqual({ uvs: false, colors: false });
    const allPrimitives = meshNodes.flatMap((node) => node.getMesh()!.listPrimitives());
    expect(allPrimitives.some((primitive) => primitive.getAttribute("TEXCOORD_0") !== null)).toBe(false);
    expect(allPrimitives.some((primitive) => primitive.getAttribute("COLOR_0") !== null)).toBe(false);
  });
});

describe.skipIf(!existsSync(exampleBlockFixturePath))("JT synthetic UV/color GLB adapter [skipped: external fixture pack unavailable]", () => {
  it("writes TEXCOORD_0 and COLOR_0 accessors for synthetic decoded attributes and reports them", async () => {
    const { synthesizeUvColorJt } = await import("@bim-studio/jt-reader/testing");
    const source = await readFile(exampleBlockFixturePath);
    const syntheticPath = path.join(await mkdtemp(path.join(tmpdir(), "bim-jt-synth-")), "synthetic.jt");
    await writeFile(syntheticPath, synthesizeUvColorJt(new Uint8Array(source)));
    const outputDir = await mkdtemp(path.join(tmpdir(), "bim-jt103-glb-"));
    directories.push(outputDir);
    const artifacts = await writeJtInspectionArtifacts(syntheticPath, outputDir);
    const result = await convertJtLod0ToGlb(
      artifacts.document,
      outputDir,
      "synthetic.jt",
      artifacts.inspection.materials,
    );
    expect(result?.decodedAttributes).toEqual({ uvs: true, colors: true });

    const glb = await new NodeIO().read(path.join(outputDir, "geometry.glb"));
    const primitives = glb.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
    expect(primitives.length).toBeGreaterThan(0);
    for (const primitive of primitives) {
      const uvs = primitive.getAttribute("TEXCOORD_0");
      const colors = primitive.getAttribute("COLOR_0");
      expect(uvs).toBeDefined();
      expect(colors).toBeDefined();
      expect(uvs!.getType()).toBe("VEC2");
      expect(colors!.getType()).toBe("VEC4");
      // 量化反解后全部落在 [0,1]
      for (const value of uvs!.getArray() as Float32Array) expect(value).toBeGreaterThanOrEqual(0), expect(value).toBeLessThanOrEqual(1);
      for (const value of colors!.getArray() as Float32Array) expect(value).toBeGreaterThanOrEqual(0), expect(value).toBeLessThanOrEqual(1);
    }
  });
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
