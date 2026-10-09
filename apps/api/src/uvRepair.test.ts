import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import JSZip from "jszip";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { inspectGlbUvs, inspectPrimitiveUvs } from "./uvInspection.js";
import {
  dedupeVerticesByAttributeKeys,
  repairGlbUvs,
  repairPrimitiveUvs,
  wrapNormalizeChannel,
  type UvRepairablePrimitive,
  type UvRepairOptions,
} from "./uvRepair.js";

const FACTORY_ZIP = path.resolve(import.meta.dirname, "../../../test-fixtures/kenney-factory/factory.zip");
const FACTORY_GLB_ENTRY = "Models/GLB format/robot-arm-a.glb";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=",
  "base64",
);

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
afterAll(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** 带两个完全重复顶点(v4=v1、v5=v2,位置与 UV 全同)的四边形。 */
function duplicateQuad(primitiveId = "dup-quad"): UvRepairablePrimitive {
  return {
    primitiveId,
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0]),
    indices: Uint32Array.from([0, 1, 2, 4, 3, 5]),
    uvChannels: {
      TEXCOORD_0: Float32Array.from([0, 0, 0.5, 0, 0, 0.5, 1, 1, 0.5, 0, 0, 0.5]),
    },
  };
}

function seamPrimitive(primitiveId = "seam"): UvRepairablePrimitive {
  // v1/v4、v2/v5 同位置但 UV 不同:真实接缝,不得被焊接合并。
  return {
    primitiveId,
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0]),
    indices: Uint32Array.from([0, 1, 2, 4, 3, 5]),
    uvChannels: {
      TEXCOORD_0: Float32Array.from([0, 0, 0.5, 0, 0, 0.5, 1, 1, 0.6, 0, 0, 0.6]),
    },
  };
}

function snapshot(view: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(view.buffer.slice(0));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

describe("T12 UV 修复:显式启用与全量记录", () => {
  it("默认关闭:零操作、输出为输入的等值拷贝、输入不被 mutate", () => {
    const input = duplicateQuad();
    const before = {
      positions: snapshot(input.positions),
      indices: snapshot(input.indices),
      uv: snapshot(input.uvChannels.TEXCOORD_0!),
    };
    const result = repairPrimitiveUvs(input, {});
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toBeUndefined();
    expect(bytesEqual(snapshot(result.primitive.positions), before.positions)).toBe(true);
    expect(bytesEqual(snapshot(result.primitive.indices), before.indices)).toBe(true);
    expect(bytesEqual(snapshot(result.primitive.uvChannels.TEXCOORD_0!), before.uv)).toBe(true);
    expect(result.primitive).not.toBe(input);
    expect(bytesEqual(snapshot(input.positions), before.positions)).toBe(true);
    expect(bytesEqual(snapshot(input.indices), before.indices)).toBe(true);
    expect(bytesEqual(snapshot(input.uvChannels.TEXCOORD_0!), before.uv)).toBe(true);
  });

  it("模 1 折回:仅折越界分量,[0,1] 内不动;按通道记录 counts;复检后越界 issue 消失", async () => {
    const input: UvRepairablePrimitive = {
      primitiveId: "wrap",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      uvChannels: {
        TEXCOORD_0: Float32Array.from([-0.25, 0, 0.5, 0, 2.5, 1, 0, 1]),
      },
    };
    const result = repairPrimitiveUvs(input, { wrapNormalize: true });
    const operation = result.operations.find((entry) => entry.operation === "UV_WRAP_NORMALIZE")!;
    expect(operation.applied).toBe(true);
    expect(operation.scope).toBe("TEXCOORD_0");
    expect(operation.counts).toMatchObject({ valuesChanged: 2, verticesChanged: 2 });
    expect(operation.detail).toContain("assumesWrappingSemantics:true");
    const uvs = result.primitive.uvChannels.TEXCOORD_0!;
    expect([...uvs]).toEqual([0.75, 0, 0.5, 0, 0.5, 1, 0, 1]);
    expect(bytesEqual(snapshot(input.uvChannels.TEXCOORD_0!), snapshot(Float32Array.from([-0.25, 0, 0.5, 0, 2.5, 1, 0, 1])))).toBe(true);
    const reInspected = await inspectPrimitiveUvs({
      primitiveId: "wrap-after",
      positions: result.primitive.positions,
      indices: result.primitive.indices,
      uvChannels: result.primitive.uvChannels,
    });
    expect(reInspected.issues).toHaveLength(0);
  });

  it("无越界分量时折回为显式 no-op(applied:false),不冒充修复", () => {
    const result = repairPrimitiveUvs(duplicateQuad(), { wrapNormalize: true });
    const operation = result.operations.find((entry) => entry.operation === "UV_WRAP_NORMALIZE")!;
    expect(operation.applied).toBe(false);
    expect(operation.detail).toContain("无越界分量");
  });

  it("焊接:仅合并键属性全同的重复顶点并重建索引;真实接缝不合并", () => {
    const dupResult = repairPrimitiveUvs(duplicateQuad(), { weldDuplicates: true });
    const dupOperation = dupResult.operations.find((entry) => entry.operation === "UV_WELD_DUPLICATES")!;
    expect(dupOperation.applied).toBe(true);
    expect(dupOperation.counts).toMatchObject({ mergedVertices: 2, verticesBefore: 6, verticesAfter: 4 });
    expect([...dupResult.primitive.indices]).toEqual([0, 1, 2, 1, 3, 2]);
    expect(dupResult.primitive.positions.length).toBe(12);

    const seamResult = repairPrimitiveUvs(seamPrimitive(), { weldDuplicates: true });
    const seamOperation = seamResult.operations.find((entry) => entry.operation === "UV_WELD_DUPLICATES")!;
    expect(seamOperation.applied).toBe(false);
    expect(seamOperation.counts).toMatchObject({ mergedVertices: 0, verticesBefore: 6, verticesAfter: 6 });
    expect(bytesEqual(snapshot(seamResult.primitive.indices), snapshot(seamPrimitive().indices))).toBe(true);
  });

  it("折回先于焊接:u=1.5 与 u=0.5 同位置顶点在折回后同键合并", () => {
    const input: UvRepairablePrimitive = {
      primitiveId: "wrap-then-weld",
      positions: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      uvChannels: {
        TEXCOORD_0: Float32Array.from([1.5, 0.5, 0.5, 0.5, 0.5, 1]),
      },
    };
    const both = repairPrimitiveUvs(input, { wrapNormalize: true, weldDuplicates: true });
    const weld = both.operations.find((entry) => entry.operation === "UV_WELD_DUPLICATES")!;
    expect(weld.counts).toMatchObject({ mergedVertices: 1, verticesBefore: 3, verticesAfter: 2 });
    // 只开焊接(不折回)时两顶点 UV 不同,不合并。
    const weldOnly = repairPrimitiveUvs(input, { weldDuplicates: true });
    expect(weldOnly.operations.find((entry) => entry.operation === "UV_WELD_DUPLICATES")!.counts.mergedVertices).toBe(0);
  });

  it("畸形输入拒绝:rejected 说明原因,原样拷贝返回,零崩溃", () => {
    const badPositions: UvRepairablePrimitive = {
      primitiveId: "bad-pos",
      positions: Float32Array.from([0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      uvChannels: { TEXCOORD_0: Float32Array.from([0, 0, 0.5, 0, 0, 0.5]) },
    };
    const badIndex: UvRepairablePrimitive = {
      primitiveId: "bad-index",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 7]),
      uvChannels: { TEXCOORD_0: Float32Array.from([0, 0, 0.5, 0, 0, 0.5]) },
    };
    const badUv: UvRepairablePrimitive = {
      primitiveId: "bad-uv",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      uvChannels: { TEXCOORD_0: Float32Array.from([Number.NaN, 0, 0.5, 0, 0, 0.5]) },
    };
    for (const [index, input] of [badPositions, badIndex, badUv].entries()) {
      const result = repairPrimitiveUvs(input, { wrapNormalize: true, weldDuplicates: true });
      expect(result.rejected, `样本 ${index}`).toBeDefined();
      expect(result.primitive.positions.length).toBe(input.positions.length);
    }
  });

  it("确定性:同输入两次修复逐位一致", () => {
    const input: UvRepairablePrimitive = {
      primitiveId: "determinism",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 2]),
      uvChannels: {
        TEXCOORD_0: Float32Array.from([-1.25, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0, 0.5]),
        TEXCOORD_1: Float32Array.from([0, 0, 0.5, 0, 0, 0.5, 2.5, 0, 0, 0.5, 0, 0.5]),
      },
    };
    const first = repairPrimitiveUvs(input, { wrapNormalize: true, weldDuplicates: true });
    const second = repairPrimitiveUvs(input, { wrapNormalize: true, weldDuplicates: true });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("去重原语:列长错配/索引越界显式抛错(核心链转为 rejected)", () => {
    expect(() => dedupeVerticesByAttributeKeys([], new Uint32Array([0, 1, 2]))).toThrow();
    expect(() => dedupeVerticesByAttributeKeys(
      [{ name: "P", elementSize: 3, data: new Float32Array(6) }],
      new Uint32Array([0, 1, 2]),
    )).toThrow(/越界/);
  });
});

describe("T12 UV 修复:GLB 回环", () => {
  it("合成 GLB:折回+焊接写回新文件,复检越界消失、顶点数下降,输入只读", async () => {
    const input = await writeSyntheticGlb({ withNormalConflict: false });
    const inputSha = createHash("sha256").update(await readFile(input)).digest("hex");
    const temp = await mkdtemp(path.join(tmpdir(), "bim-t12-uv-repair-"));
    directories.push(temp);
    const output = path.join(temp, "repaired.glb");
    const report = await repairGlbUvs(input, output, { wrapNormalize: true, weldDuplicates: true });
    expect(createHash("sha256").update(await readFile(input)).digest("hex")).toBe(inputSha);
    expect(report.outputWritten).toBe(true);
    expect(report.changedPrimitiveCount).toBe(1);
    const operations = report.operations.filter((entry) => entry.primitiveId === "mesh:0/primitive:0");
    expect(operations.some((entry) => entry.operation === "UV_WRAP_NORMALIZE" && entry.applied)).toBe(true);
    expect(operations.some((entry) => entry.operation === "UV_WELD_DUPLICATES" && entry.applied)).toBe(true);

    const io = new NodeIO();
    const outputDocument = await io.read(output);
    const primitive = outputDocument.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(primitive.getAttribute("POSITION")!.getCount()).toBe(4);
    const reInspected = await inspectGlbUvs(output);
    expect(reInspected.issues.find((entry) => entry.code === "UV_OUT_OF_RANGE")).toBeUndefined();
    expect(reInspected.ok).toBe(true);
  });

  it("GLB 焊接键含全部属性:同位置同 UV 但 NORMAL 冲突的顶点在 GLB 链不合并(核心链会合并)", async () => {
    const input = await writeSyntheticGlb({ withNormalConflict: true });
    const temp = await mkdtemp(path.join(tmpdir(), "bim-t12-uv-allkey-"));
    directories.push(temp);
    const report = await repairGlbUvs(input, path.join(temp, "out.glb"), { weldDuplicates: true });
    const weld = report.operations.find((entry) => entry.operation === "UV_WELD_DUPLICATES")!;
    expect(weld.applied).toBe(false);
    expect(weld.counts.mergedVertices).toBe(0);
    expect(weld.detail).toContain("keys:POSITION,TEXCOORD_0,NORMAL");
    expect(weld.counts.keyAttributes).toBe(3);

    const coreResult = repairPrimitiveUvs({
      primitiveId: "core",
      positions: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      uvChannels: { TEXCOORD_0: Float32Array.from([0.1, 0.1, 0.1, 0.1, 0.8, 0.8]) },
    }, { weldDuplicates: true });
    expect(coreResult.operations.find((entry) => entry.operation === "UV_WELD_DUPLICATES")!.counts.mergedVertices).toBe(1);
  });

  it("真实 GLB(T00 工厂 robot-arm-a):全图元修复无崩溃、逐图元记录、输入只读", async () => {
    const input = await realFile();
    const inputSha = createHash("sha256").update(await readFile(input)).digest("hex");
    const temp = await mkdtemp(path.join(tmpdir(), "bim-t12-uv-real-"));
    directories.push(temp);
    const output = path.join(temp, "repaired.glb");
    const report = await repairGlbUvs(input, output, { wrapNormalize: true, weldDuplicates: true });
    expect(createHash("sha256").update(await readFile(input)).digest("hex")).toBe(inputSha);
    expect(report.primitiveCount).toBe(9);
    expect(report.primitives).toHaveLength(9);
    expect(report.primitives.every((record) => record.rejection === undefined)).toBe(true);
    const wrapSummary = report.operations.filter((entry) => entry.operation === "UV_WRAP_NORMALIZE");
    const weldSummary = report.operations.filter((entry) => entry.operation === "UV_WELD_DUPLICATES");
    console.log("[T12 UV 真实 GLB robot-arm-a 修复]", JSON.stringify({
      changedPrimitiveCount: report.changedPrimitiveCount,
      wrapOperations: wrapSummary.map((entry) => ({
        primitiveId: entry.primitiveId,
        applied: entry.applied,
        counts: entry.counts,
      })),
      weldOperations: weldSummary.map((entry) => ({
        primitiveId: entry.primitiveId,
        applied: entry.applied,
        counts: entry.counts,
      })),
    }));
  });
});

let tempSequence = 0;

async function writeSyntheticGlb(options: { withNormalConflict: boolean }): Promise<string> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("scene");
  const texture = document.createTexture("tex").setMimeType("image/png").setImage(new Uint8Array(TINY_PNG));
  // 缺省 TextureInfo wrapS/wrapT = REPEAT,无需显式设置。
  const material = document.createMaterial("mat").setBaseColorTexture(texture);

  // 6 顶点(4 唯一 + v4=v1、v5=v2 全同重复),首顶点 UV 越界。
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = Float32Array.from([-0.25, 0, 0.5, 0, 0, 0.5, 1, 1, 0.5, 0, 0, 0.5]);
  const primitive = document.createPrimitive()
    .setMaterial(material)
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(positions))
    .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setBuffer(buffer).setArray(uvs))
    .setIndices(document.createAccessor().setType("SCALAR").setBuffer(buffer)
      .setArray(Uint32Array.from([0, 1, 2, 4, 3, 5])));
  if (options.withNormalConflict) {
    // 3 顶点:两个同位置同 UV 但 NORMAL 相反;仅供全键焊接语义验证(独立图元)。
    primitive
      .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer)
        .setArray(Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0])))
      .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setBuffer(buffer)
        .setArray(Float32Array.from([0.1, 0.1, 0.1, 0.1, 0.8, 0.8])))
      .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setBuffer(buffer)
        .setArray(Float32Array.from([0, 0, 1, 0, 0, -1, 0, 1, 0])))
      .setIndices(document.createAccessor().setType("SCALAR").setBuffer(buffer)
        .setArray(Uint32Array.from([0, 1, 2])));
  }
  const mesh = document.createMesh("mesh").addPrimitive(primitive);
  scene.addChild(document.createNode("node").setMesh(mesh));

  const temp = await mkdtemp(path.join(tmpdir(), `bim-t12-uv-src-${tempSequence += 1}-`));
  directories.push(temp);
  const file = path.join(temp, "source.glb");
  await new NodeIO().write(file, document);
  return file;
}

let realFilePromise: Promise<string> | null = null;
async function realFile(): Promise<string> {
  realFilePromise ??= (async () => {
    const zip = await JSZip.loadAsync(await readFile(FACTORY_ZIP));
    const entry = zip.file(FACTORY_GLB_ENTRY);
    if (!entry) throw new Error(`factory.zip 缺少 ${FACTORY_GLB_ENTRY}`);
    const temp = await mkdtemp(path.join(tmpdir(), "bim-t12-uv-realglb-"));
    directories.push(temp);
    await writeFile(path.join(temp, "model.glb"), await entry.async("nodebuffer"));
    const texturePrefix = "Models/GLB format/Textures/";
    for (const textureName of Object.keys(zip.files).filter((name) => name.startsWith(texturePrefix))) {
      const textureEntry = zip.file(textureName);
      if (!textureEntry || textureEntry.dir) continue;
      const relative = textureName.slice(texturePrefix.length);
      if (relative.length === 0) continue;
      const destination = path.join(temp, "Textures", ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await textureEntry.async("nodebuffer"));
    }
    return path.join(temp, "model.glb");
  })();
  return realFilePromise;
}
