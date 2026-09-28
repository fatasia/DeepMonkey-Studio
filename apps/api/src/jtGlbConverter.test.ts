import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
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
    expect(result?.decodedAttributes).toEqual({ uvs: false, colors: false, textureSetCount: 0 });
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
    expect(result?.decodedAttributes).toEqual({ uvs: true, colors: true, textureSetCount: 1 });

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

describe.skipIf(!existsSync(exampleBlockFixturePath))("JT dual texture-set GLB adapter [skipped: external fixture pack unavailable]", () => {
  it("preserves a lone nonzero source set through reader and GLB without inventing TEXCOORD_0", async () => {
    const { synthesizeSingleNonzeroTextureSetJt } = await import("@bim-studio/jt-reader/testing");
    const source = await readFile(exampleBlockFixturePath);
    const inputDir = await mkdtemp(path.join(tmpdir(), "bim-jt-sparse-source-"));
    const outputDir = await mkdtemp(path.join(tmpdir(), "bim-jt-sparse-glb-"));
    directories.push(inputDir, outputDir);
    const inputPath = path.join(inputDir, "single-set-1.jt");
    await writeFile(inputPath, synthesizeSingleNonzeroTextureSetJt(new Uint8Array(source)));
    const artifacts = await writeJtInspectionArtifacts(inputPath, outputDir);
    const result = await convertJtLod0ToGlb(artifacts.document, outputDir, "single-set-1.jt", artifacts.inspection.materials);
    expect(result?.decodedAttributes).toMatchObject({ uvs: true, textureSetCount: 1 });
    const glb = await new NodeIO().read(path.join(outputDir, "geometry.glb"));
    const primitive = glb.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())[0]!;
    expect(primitive.getAttribute("TEXCOORD_0")).toBeNull();
    expect(primitive.getAttribute("TEXCOORD_1")).not.toBeNull();
    expect(primitive.getExtras()).toMatchObject({ TextureSetCount: 1, TextureSetIndices: [1] });
    const malformed = structuredClone(artifacts.document);
    const sourceMesh = malformed.meshes.find((mesh) => mesh.lod === 0)!;
    sourceMesh.textureSets!.push({ textureSetIndex: 1, uvs: sourceMesh.textureSets![0]!.uvs });
    expect(await convertJtLod0ToGlb(malformed, outputDir, "duplicate-set.jt", artifacts.inspection.materials)).toBeUndefined();
  });

  it("keeps per-mesh texture evidence truthful in a mixed assembly", async () => {
    const { synthesizeDualTextureSetJt } = await import("@bim-studio/jt-reader/testing");
    const source = await readFile(exampleBlockFixturePath);
    const inputDir = await mkdtemp(path.join(tmpdir(), "bim-jt-mixed-source-"));
    const outputDir = await mkdtemp(path.join(tmpdir(), "bim-jt-mixed-glb-"));
    directories.push(inputDir, outputDir);
    const inputPath = path.join(inputDir, "mixed.jt");
    await writeFile(inputPath, synthesizeDualTextureSetJt(new Uint8Array(source)));
    const artifacts = await writeJtInspectionArtifacts(inputPath, outputDir);
    const document = structuredClone(artifacts.document);
    const original = document.meshes.find((mesh) => mesh.lod === 0)!;
    const plain = structuredClone(original);
    plain.id = `${original.id}:plain`;
    delete plain.uvs;
    delete plain.textureSets;
    document.meshes.push(plain);
    const instance = document.meshInstances.find((item) => item.meshId === original.id)!;
    document.meshInstances.push({ ...instance, id: `${instance.id}:plain`, meshId: plain.id });

    const result = await convertJtLod0ToGlb(document, outputDir, "mixed.jt", artifacts.inspection.materials);
    expect(result?.decodedAttributes.textureSetCount).toBe(2);
    const glb = await new NodeIO().read(path.join(outputDir, "geometry.glb"));
    const primitives = glb.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
    expect(primitives.some((primitive) => primitive.getExtras().TextureSetCount === 2
      && primitive.getAttribute("TEXCOORD_1") !== null)).toBe(true);
    expect(primitives.some((primitive) => primitive.getExtras().TextureSetCount === undefined
      && primitive.getAttribute("TEXCOORD_0") === null)).toBe(true);
  });

  it("exports TEXCOORD_0..1 for dual texture sets with mesh extras and linkage loss evidence", async () => {
    const { synthesizeDualTextureSetJt } = await import("@bim-studio/jt-reader/testing");
    const source = await readFile(exampleBlockFixturePath);
    const syntheticPath = path.join(await mkdtemp(path.join(tmpdir(), "bim-jt-dual-")), "dual.jt");
    await writeFile(syntheticPath, synthesizeDualTextureSetJt(new Uint8Array(source)));
    const outputDir = await mkdtemp(path.join(tmpdir(), "bim-jt-dual-glb-"));
    directories.push(outputDir);
    const artifacts = await writeJtInspectionArtifacts(syntheticPath, outputDir);
    const result = await convertJtLod0ToGlb(
      artifacts.document,
      outputDir,
      "dual.jt",
      artifacts.inspection.materials,
    );
    expect(result?.decodedAttributes).toEqual({ uvs: true, colors: false, textureSetCount: 2 });

    const glb = await new NodeIO().read(path.join(outputDir, "geometry.glb"));
    const primitives = glb.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
    expect(primitives.length).toBeGreaterThan(0);
    for (const primitive of primitives) {
      expect(primitive.getAttribute("TEXCOORD_0")).toBeDefined();
      expect(primitive.getAttribute("TEXCOORD_1")).toBeDefined();
      // 上限外无第三套;COLOR 未解码不得出现。
      expect(primitive.getAttribute("TEXCOORD_2")).toBeNull();
      expect(primitive.getAttribute("COLOR_0")).toBeNull();
      const extras = primitive.getExtras() as { TextureSetCount?: number; TextureSetIndices?: number[] };
      expect(extras.TextureSetCount).toBe(2);
      expect(extras.TextureSetIndices).toEqual([0, 1]);
    }
    // 两套集合的 UV 必须是不同 accessor(不混流)且逐顶点互补。
    const first = primitives[0]!;
    const u0 = first.getAttribute("TEXCOORD_0")!.getArray() as Float32Array;
    const u1 = first.getAttribute("TEXCOORD_1")!.getArray() as Float32Array;
    expect(u0.length).toBe(u1.length);
    for (let index = 0; index < u0.length; index += 2) {
      expect(u0[index]! + u1[index]!).toBeCloseTo(1, 4);
    }
  });
});

const independentTextureFixturePath = fileURLToPath(new URL(
  "../../../data/external-assets/format-fixtures/jt/independent-texture/painted-instanced-10.3.jt", import.meta.url,
));

describe.skipIf(!existsSync(independentTextureFixturePath))("JT independently authored inline image GLB path", () => {
  it("rejects an image whose requested source UV set is absent instead of publishing a partial GLB", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jt-texture-missing-uv-"));
    directories.push(dir);
    const artifacts = await writeJtInspectionArtifacts(independentTextureFixturePath, dir);
    artifacts.document.meshes[0]!.textureSets![0]!.textureSetIndex = 2;
    expect(await convertJtLod0ToGlb(artifacts.document, dir, "invalid.jt", artifacts.inspection.materials)).toBeUndefined();
    expect(existsSync(path.join(dir, "geometry.glb"))).toBe(false);
  });

  it("exports image bytes, inherited material, explicit texCoord 1 and two shared instances", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jt-texture-glb-"));
    directories.push(dir);
    const artifacts = await writeJtInspectionArtifacts(independentTextureFixturePath, dir);
    expect(artifacts.document.header).toMatchObject({ majorVersion: 10, minorVersion: 3 });
    expect(artifacts.document.meshes).toHaveLength(1);
    expect(artifacts.document.meshes[0]!.textureSets?.map((set) => set.textureSetIndex)).toEqual([1]);
    expect(artifacts.document.meshInstances).toHaveLength(2);
    expect(artifacts.inspection.materials.map((item) => item.objectId)).toEqual([1]);
    const result = await convertJtLod0ToGlb(artifacts.document, dir, "painted-instanced-10.3.jt", artifacts.inspection.materials);
    expect(result).toMatchObject({ meshCount: 1, instanceCount: 2, triangleCount: 12 });
    const glb = await new NodeIO().read(path.join(dir, "geometry.glb"));
    const nodes = glb.getRoot().listNodes().filter((node) => node.getMesh());
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.getMesh()).toBe(nodes[1]!.getMesh());
    expect(nodes.map((node) => node.getMatrix()[12])).toEqual([0, 3]);
    for (const node of nodes) {
      expect(node.getExtras()).toMatchObject({ MaterialStatus: "source-path", MaterialSourceObjectIds: [1] });
      for (const primitive of node.getMesh()!.listPrimitives()) {
        expect(primitive.getAttribute("TEXCOORD_0")).toBeNull();
        expect(primitive.getAttribute("TEXCOORD_1")).not.toBeNull();
        const material = primitive.getMaterial()!;
        expect(material.getBaseColorTextureInfo()?.getTexCoord()).toBe(1);
        const image = material.getBaseColorTexture()?.getImage();
        expect(image?.subarray(0, 8)).toEqual(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(image?.length).toBeGreaterThan(50);
        const bytes = Buffer.from(image!);
        expect(bytes.readUInt32BE(16)).toBe(2);
        expect(bytes.readUInt32BE(20)).toBe(2);
        const compressedLength = bytes.readUInt32BE(33);
        const scanlines = inflateSync(bytes.subarray(41, 41 + compressedLength));
        expect([...scanlines]).toEqual([
          0, 255, 35, 45, 255, 25, 240, 135, 255,
          0, 25, 95, 255, 255, 255, 210, 20, 255,
        ]);
      }
    }
    const sourcePixels = artifacts.document.sceneGraph.nodes[0]!.textureImages![0]!.pixels;
    expect([...sourcePixels]).toEqual([255, 35, 45, 255, 25, 240, 135, 255, 25, 95, 255, 255, 255, 210, 20, 255]);
  });
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
