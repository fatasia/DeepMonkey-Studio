import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, NodeIO, type Material } from "@gltf-transform/core";
import JSZip from "jszip";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  UV_ISSUE_DICTIONARY,
  UV_OVERLAP_ISLAND_SCAN_LIMIT,
  inspectGlbUvs,
  inspectMeshUvs,
  inspectPrimitiveUvs,
  type MeshPrimitiveUvInput,
} from "./uvInspection.js";

const FACTORY_ZIP = path.resolve(import.meta.dirname, "../../../data/external-assets/open-packs/factory.zip");
const FACTORY_GLB_ENTRY = "Models/GLB format/robot-arm-a.glb";
/** 1×1 透明 PNG,供合成纹理材质写入 GLB。 */
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

function quad(primitiveId: string, uvs: number[], overrides: Partial<MeshPrimitiveUvInput> = {}): MeshPrimitiveUvInput {
  return {
    primitiveId,
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    uvChannels: { TEXCOORD_0: Float32Array.from(uvs) },
    ...overrides,
  };
}

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((entry) => entry.code);
}

function firstIssue(
  report: { issues: Array<{ code: string; count: number; samples: string[]; detail?: string }> },
  code: string,
): { count: number; samples: string[]; detail?: string } {
  const found = report.issues.find((entry) => entry.code === code);
  expect(found, `缺少 issue ${code},实际:${codes(report.issues).join(",")}`).toBeDefined();
  return found!;
}

describe("T12 UV 检查 issue 字典", () => {
  it("每个码都有唯一严重级、含义与定位符格式", () => {
    const entries = Object.entries(UV_ISSUE_DICTIONARY);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const [code, descriptor] of entries) {
      expect(["error", "warning", "info"], code).toContain(descriptor.severity);
      expect(descriptor.meaning.length, code).toBeGreaterThan(4);
      expect(descriptor.locator, code).toContain("<");
    }
    expect(UV_ISSUE_DICTIONARY.UV_OUT_OF_RANGE.severity).toBe("warning");
    expect(UV_ISSUE_DICTIONARY.TEXCOORD_MISSING.severity).toBe("error");
    expect(UV_ISSUE_DICTIONARY.UV_SEAM_SPLIT.severity).toBe("info");
  });
});

describe("T12 UV 检查:合成样本矩阵(只检测不修补,无崩溃)", () => {
  it("干净四边形:ok=true、零 issue、单 UV 岛", async () => {
    const report = await inspectPrimitiveUvs(quad("clean", [0, 0, 1, 0, 1, 1, 0, 1]));
    expect(report.issues).toHaveLength(0);
    expect(report.islandCount).toBe(1);
    expect(report.stats[0]!.outOfRangeValues).toBe(0);
    const aggregate = await inspectMeshUvs([quad("clean", [0, 0, 1, 0, 1, 1, 0, 1])]);
    expect(aggregate.ok).toBe(true);
    expect(aggregate.uvChannelCount).toBe(1);
  });

  it("越界 UV 无 wrapping 声明 → UV_OUT_OF_RANGE warning;声明平铺后不报但统计保留", async () => {
    const undeclared = await inspectPrimitiveUvs(quad("uv-range", [-0.25, 0, 0.5, 0, 2.5, 1, 0, 1]));
    const issue = firstIssue(undeclared, "UV_OUT_OF_RANGE");
    expect(issue.count).toBe(2);
    expect(issue.samples[0]).toMatch(/vertex:0 uv:-0\.25,0/);
    expect(issue.detail).toContain("channel:TEXCOORD_0 minU:-0.25 maxU:2.5");
    expect(undeclared.stats[0]!.wrappingDeclared).toBe(false);

    const declared = await inspectPrimitiveUvs(quad("uv-tiled", [-0.25, 0, 0.5, 0, 2.5, 1, 0, 1],
      { wrappingDeclaredChannels: { TEXCOORD_0: true } }));
    expect(declared.issues).toHaveLength(0);
    expect(declared.stats[0]!.outOfRangeValues).toBe(2);
    expect(declared.stats[0]!.wrappingDeclared).toBe(true);
    expect(declared.stats[0]!.maxU).toBe(2.5);
  });

  it("重叠 UV 岛 → UV_OVERLAP warning;不重叠双岛不报", async () => {
    const overlapping: MeshPrimitiveUvInput = {
      primitiveId: "overlap",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      uvChannels: {
        TEXCOORD_0: Float32Array.from([0, 0, 0.4, 0, 0, 0.4, 0.1, 0.1, 0.5, 0.1, 0.1, 0.5]),
      },
    };
    const report = await inspectPrimitiveUvs(overlapping);
    const overlap = firstIssue(report, "UV_OVERLAP");
    expect(overlap.count).toBe(1);
    expect(overlap.samples.join("\n")).toContain("bounds:[0,0,0.4,0.4]");
    expect(overlap.samples.join("\n")).toContain("bounds:[0.1,0.1,0.5,0.5]");
    expect(report.islandCount).toBe(2);

    const separated: MeshPrimitiveUvInput = {
      ...overlapping,
      primitiveId: "separated",
      uvChannels: {
        TEXCOORD_0: Float32Array.from([0, 0, 0.4, 0, 0, 0.4, 0.5, 0.5, 0.9, 0.5, 0.5, 0.9]),
      },
    };
    const separatedReport = await inspectPrimitiveUvs(separated);
    expect(separatedReport.issues).toHaveLength(0);
    expect(separatedReport.islandCount).toBe(2);
  });

  it("同位置顶点 UV 分裂(接缝)→ UV_SEAM_SPLIT info,按位置组计数", async () => {
    const seam: MeshPrimitiveUvInput = {
      primitiveId: "seam",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 4, 3, 5]),
      uvChannels: {
        TEXCOORD_0: Float32Array.from([0, 0, 0.5, 0, 0, 0.5, 1, 1, 0.6, 0, 0, 0.6]),
      },
    };
    const report = await inspectPrimitiveUvs(seam);
    const seamIssue = firstIssue(report, "UV_SEAM_SPLIT");
    expect(seamIssue.count).toBe(2);
    expect(seamIssue.samples).toContain("channel:TEXCOORD_0 position:1 uvVariants:2");
    expect(report.stats[0]!.seamSplitPositions).toBe(2);
  });

  it("零面积 UV 三角形(几何有效)→ UV_DEGENERATE_TRIANGLE warning", async () => {
    const degenerate: MeshPrimitiveUvInput = {
      primitiveId: "uv-degenerate",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      uvChannels: {
        TEXCOORD_0: Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      },
    };
    const report = await inspectPrimitiveUvs(degenerate);
    const issue = firstIssue(report, "UV_DEGENERATE_TRIANGLE");
    expect(issue.count).toBe(1);
    expect(issue.samples[0]).toContain("triangle:0 reason:zero-area-uv");
    expect(report.stats[0]!.degenerateTriangles).toBe(1);
  });

  it("材质需要纹理但无 UV → TEXCOORD_MISSING error", async () => {
    const missing: MeshPrimitiveUvInput = {
      primitiveId: "no-uv",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      uvChannels: {},
      requiredUvChannels: ["TEXCOORD_0"],
    };
    const report = await inspectPrimitiveUvs(missing);
    const issue = firstIssue(report, "TEXCOORD_MISSING");
    expect(issue.count).toBe(1);
    expect(issue.samples[0]).toBe("channel:TEXCOORD_0");
    const aggregate = await inspectMeshUvs([missing]);
    expect(aggregate.ok).toBe(false);
  });

  it("畸形输入:长度错配/非有限/索引截断 → MALFORMED_INPUT 且零崩溃", async () => {
    const badLength = await inspectPrimitiveUvs(quad("bad-length", [0, 0, 1, 0, 1]));
    expect(codes(badLength.issues)).toContain("MALFORMED_INPUT");
    expect(badLength.issues.find((entry) => entry.code === "MALFORMED_INPUT")!.samples[0])
      .toContain("attribute:TEXCOORD_0 length:5");

    const nan = await inspectPrimitiveUvs(quad("nan", [Number.NaN, 0, 0.5, 0, 0.5, 0.5, 0, 0]));
    const nanIssue = nan.issues.find((entry) => entry.code === "MALFORMED_INPUT")!;
    expect(nanIssue.count).toBe(1);
    expect(nanIssue.samples[0]).toContain("attribute:TEXCOORD_0 non-finite");

    const truncated = await inspectPrimitiveUvs({
      primitiveId: "truncated",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1]),
      uvChannels: { TEXCOORD_0: Float32Array.from([0, 0, 0.5, 0, 0, 0.5]) },
    });
    const truncatedIssue = truncated.issues.find((entry) => entry.code === "MALFORMED_INPUT")!;
    expect(truncatedIssue.samples[0]).toContain("attribute:indices length:2");

    const badPositions = await inspectPrimitiveUvs({
      primitiveId: "bad-positions",
      positions: Float32Array.from([0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      uvChannels: { TEXCOORD_0: Float32Array.from([0, 0, 0.5, 0, 0, 0.5]) },
    });
    expect(badPositions.issues.some((entry) => entry.code === "MALFORMED_INPUT"
      && entry.samples[0]!.startsWith("attribute:POSITION"))).toBe(true);
    // 位置畸形时跳过接缝/退化统计,但仍产出顶点级统计之外的全部 issue 且不崩溃。
    expect(badPositions.stats).toHaveLength(0);
  });

  it("岛重叠扫描截断诚实声明:capped:true 且 countIsLowerBound:true", async () => {
    const triangleCount = UV_OVERLAP_ISLAND_SCAN_LIMIT + 6;
    const positions = new Float32Array(triangleCount * 9);
    const uvs = new Float32Array(triangleCount * 6);
    const indices = new Uint32Array(triangleCount * 3);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      // 岛间距 1e-4 远小于岛宽 0.8:全部岛两两重叠,但角点键互不相同(岛数 = 三角形数)。
      const base = triangle * 0.0001;
      for (let corner = 0; corner < 3; corner += 1) {
        positions[triangle * 9 + corner * 3] = corner;
        positions[triangle * 9 + corner * 3 + 1] = triangle;
        uvs[triangle * 6 + corner * 2] = base + corner * 0.4;
        uvs[triangle * 6 + corner * 2 + 1] = corner * 0.3;
        indices[triangle * 3 + corner] = triangle * 3 + corner;
      }
    }
    const report = await inspectPrimitiveUvs({
      primitiveId: "capped",
      positions,
      indices,
      uvChannels: { TEXCOORD_0: uvs },
    });
    const overlap = firstIssue(report, "UV_OVERLAP");
    expect(overlap.detail).toContain("capped:true");
    expect(overlap.detail).toContain("countIsLowerBound:true");
    expect(report.stats[0]!.islandCount).toBe(triangleCount);
  });

  it("确定性:同输入两次检查报告逐字段一致", async () => {
    const sample: MeshPrimitiveUvInput = {
      primitiveId: "determinism",
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      uvChannels: {
        TEXCOORD_0: Float32Array.from([0, 0, 0.4, 0, 0, 0.4, 0.1, 0.1, 0.5, 0.1, 0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
        TEXCOORD_1: Float32Array.from([-1, 0, 0.4, 0, 0, 0.4, 0.1, 0.1, 0.5, 0.1, 0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      },
      wrappingDeclaredChannels: { TEXCOORD_1: true },
      requiredUvChannels: ["TEXCOORD_0", "TEXCOORD_1"],
    };
    const firstRun = await inspectPrimitiveUvs(sample);
    const secondRun = await inspectPrimitiveUvs(sample);
    expect(JSON.stringify(firstRun)).toBe(JSON.stringify(secondRun));
  });
});

describe("T12 UV 检查:GLB 适配器", () => {
  it("合成 GLB:clamp 采样器报越界、repeat 不报、缺 TEXCOORD 报 error", async () => {
    const file = await writeSyntheticGlb();
    const report = await inspectGlbUvs(file);
    expect(report.primitiveCount).toBe(3);
    expect(codes(report.issues)).toContain("TEXCOORD_MISSING");
    expect(report.ok).toBe(false);
    const clamp = report.issues.find((entry) => entry.code === "UV_OUT_OF_RANGE"
      && entry.primitiveId === "mesh:0/primitive:0");
    expect(clamp).toBeDefined();
    const repeatSide = report.issues.find((entry) => entry.code === "UV_OUT_OF_RANGE"
      && entry.primitiveId === "mesh:1/primitive:0");
    expect(repeatSide).toBeUndefined();
    const repeatStats = report.channelStats.find((entry) => entry.primitiveId === "mesh:1/primitive:0");
    expect(repeatStats!.outOfRangeValues).toBe(2);
    expect(repeatStats!.wrappingDeclared).toBe(true);
    const missingStats = report.channelStats.find((entry) => entry.primitiveId === "mesh:2/primitive:0");
    expect(missingStats).toBeUndefined();
  });

  it("真实 GLB(T00 工厂 robot-arm-a):结构完整、逐通道统计、只读不写", async () => {
    const file = await realFile();
    const before = createHash("sha256").update(await readFile(file)).digest("hex");
    const report = await inspectGlbUvs(file);
    const after = createHash("sha256").update(await readFile(file)).digest("hex");
    expect(after).toBe(before);
    expect(report.primitiveCount).toBeGreaterThan(0);
    expect(report.triangleCount).toBeGreaterThan(0);
    expect(report.uvChannelCount).toBeGreaterThan(0);
    expect(report.issues.every((entry) => UV_ISSUE_DICTIONARY[entry.code] !== undefined)).toBe(true);
    console.log("[T12 UV 真实 GLB robot-arm-a]", JSON.stringify({
      primitiveCount: report.primitiveCount,
      vertexCount: report.vertexCount,
      triangleCount: report.triangleCount,
      uvChannelCount: report.uvChannelCount,
      islandCount: report.islandCount,
      ok: report.ok,
      issueCountsByCode: report.issueCountsByCode,
      channels: report.channelStats.map((entry) => ({
        channel: entry.channel,
        vertexCount: entry.vertexCount,
        outOfRangeValues: entry.outOfRangeValues,
        wrappingDeclared: entry.wrappingDeclared,
        seamSplitPositions: entry.seamSplitPositions,
        degenerateTriangles: entry.degenerateTriangles,
        islandCount: entry.islandCount,
      })),
    }));
  });
});

async function writeSyntheticGlb(): Promise<string> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("scene");
  // glTF Transform v4:采样器语义并入 TextureInfo,缺省 wrapS/wrapT = REPEAT。
  const textureClamp = document.createTexture("tex-clamp").setMimeType("image/png").setImage(new Uint8Array(TINY_PNG));
  const textureRepeat = document.createTexture("tex-repeat").setMimeType("image/png").setImage(new Uint8Array(TINY_PNG));

  const makePrimitive = (material: Material, withUv: boolean) => {
    const primitive = document.createPrimitive()
      .setMaterial(material)
      .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer)
        .setArray(Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])))
      .setIndices(document.createAccessor().setType("SCALAR").setBuffer(buffer)
        .setArray(Uint32Array.from([0, 1, 2, 0, 2, 3])));
    if (withUv) {
      primitive.setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setBuffer(buffer)
        .setArray(Float32Array.from([-0.25, 0, 0.5, 0, 2.5, 1, 0, 1])));
    }
    return primitive;
  };

  const clampMaterial = document.createMaterial("clamp-mat").setBaseColorTexture(textureClamp);
  clampMaterial.getBaseColorTextureInfo()!.setWrapS(33071).setWrapT(33071);
  const repeatMaterial = document.createMaterial("repeat-mat").setBaseColorTexture(textureRepeat);
  const missingMaterial = document.createMaterial("missing-mat").setBaseColorTexture(textureRepeat);

  const configs: Array<{ material: Material; withUv: boolean }> = [
    { material: clampMaterial, withUv: true },
    { material: repeatMaterial, withUv: true },
    { material: missingMaterial, withUv: false },
  ];
  configs.forEach((config, index) => {
    const mesh = document.createMesh(`mesh-${index}`).addPrimitive(makePrimitive(config.material, config.withUv));
    scene.addChild(document.createNode(`node-${index}`).setMesh(mesh));
  });

  const temp = await mkdtemp(path.join(tmpdir(), "bim-t12-uv-glb-"));
  directories.push(temp);
  const file = path.join(temp, "synthetic.glb");
  await new NodeIO().write(file, document);
  return file;
}

/** 解压一次 T00 工厂资产(Kenney factory kit,CC0)中的 robot-arm-a.glb 及其同级纹理。 */
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
