import { existsSync, fstatSync, openSync, readdirSync, readSync, closeSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSyntheticXtText } from "@bim-studio/xt-reader";
import { convertXtGenericTextToGlb } from "./xtGenericConverter.js";
import { probeXtFileStructure } from "./industrialFormatProbe.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cadconvertPath = path.join(repoRoot, "data/external-assets/format-fixtures/x_t/cadconvert-small.x_t");
const samplesRoot = path.join(repoRoot, "data/external-assets/industrial-format-plan/samples/downloaded/x_t");

const SYNTHETIC_RECORDS = [
  "52 255 1 1 0 0 0 0 0  0 0 0  0 0 1  1 0 0  0 1 0",
  "53 255 20 1 0 0 0 0 0  0 2.5 0  0 0 1  1 0 0  2",
  "31 255 21 1 0 0 0 0 0  0 2.5 0  0 0 1  1 0 0  2",
  "31 255 22 1 0 0 0 0 0  0 2.5 12  0 0 1  1 0 0  2",
  "55 255 40 1 0 0 0 0 0  8 0 0  0 0 1  1 0 0  .866  3",
  "57 255 50 1 0 0  30 30 30  4",
  "100 255 60 1 0 0  1 0 0 0 1 0 0 0 1  5 0 0",
].join("\n");

const cleanupTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanupTasks.length) await cleanupTasks.pop()!();
});

async function tempOutput(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "xt-generic-"));
  cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSource(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "xt-generic-src-"));
  cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

describe("generic X_T text converter", () => {
  it("publishes partial GLB with honest losses for the synthetic plane/cylinder/cone/sphere part", async () => {
    const source = await writeSource("synthetic.x_t", buildSyntheticXtText({ schema: "SCH_999999_20000", records: SYNTHETIC_RECORDS }));
    const outputDir = await tempOutput();
    const result = await convertXtGenericTextToGlb(source, outputDir);
    // 球 + 柱面(记录+同轴圆边) 可发布；平面/圆锥/圆边如实列为损失。
    expect(result.partial).toBe(true);
    expect(result.meshCount).toBe(2);
    expect(result.familyCounts).toMatchObject({ planes: 1, cylinders: 1, cones: 1, spheres: 1, circles: 2, transforms: 1 });
    expect(result.losses).toContain("surface.plane:untrimmed-extent-unknown");
    expect(result.losses).toContain("surface.cone:axial-extent-unknown");
    expect(result.losses).toContain("assembly.instance-linkage");
    // 柱面记录命中时直接发布；重构路径由真实铰链样本测试覆盖。
    expect(result.approximations).toContain("geometry.tessellation:angular-64-segments");

    const hierarchy = JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8"));
    expect(hierarchy.partial).toBe(true);
    expect(hierarchy.root.children[0].name).toBe("PART 1");
    expect(hierarchy.root.children[0].meshIds).toHaveLength(2);

    const properties = JSON.parse(await readFile(path.join(outputDir, "properties.json"), "utf8"));
    expect(properties.model.transforms).toHaveLength(1);
    expect(properties.model.transformLinkage).toBe("not-applied-owner-linkage-unverified");
    expect(properties.model.units).toBe("source-units-preserved");
    expect(Object.keys(properties.elements)).toHaveLength(2);
    const sources = Object.values(properties.elements).map((element) => (element as { displayProperties: { 来源: string } }).displayProperties.来源);
    expect(sources).toContain("cylinder-record+coaxial-circles");
    expect(sources).toContain("sphere-record");

    // GLB 与探测证据同源：结构探测仍识别为 X_T 文本流。
    const probe = await probeXtFileStructure(source, "x_t");
    expect(probe.status).toBe("header-recognized");
    expect(probe.encoding).toBe("text");
  });

  it.runIf(existsSync(cadconvertPath))("converts the signed real sample with partial output and no fabricated geometry", async () => {
    const outputDir = await tempOutput();
    const result = await convertXtGenericTextToGlb(cadconvertPath, outputDir);
    expect(result.schema).toBe("SCH_2401231_20000_1300");
    expect(result.encodingClass).toBe("format-text");
    // 旋转体轮廓圆边半径各不相同，没有同轴等径对：不得虚构圆柱。
    expect(result.familyCounts.circles).toBe(10);
    expect(result.familyCounts.tori).toBe(1);
    expect(result.losses).toContain("surface.torus:arc-extent-unknown");
    expect(result.partial).toBe(true);
    await expect(readFile(path.join(outputDir, "geometry.glb"))).resolves.toBeInstanceOf(Buffer);
  });

  const hingeSample = findHingeSampleWithCoaxialHoles();
  it.runIf(hingeSample)("reconstructs real hole cylinders from coaxial circle edges", async () => {
    const outputDir = await tempOutput();
    const result = await convertXtGenericTextToGlb(hingeSample!, outputDir);
    expect(result.encodingClass).toBe("format-text");
    expect(result.meshCount).toBeGreaterThan(0);
    expect(result.approximations).toContain("surface.cylinder:reconstructed-from-coaxial-circle-pairs");
    expect(result.triangleCount).toBeGreaterThan(0);
  });
});

function findHingeSampleWithCoaxialHoles(): string | undefined {
  if (!existsSync(samplesRoot)) return undefined;
  for (const file of listXtFiles(samplesRoot)) {
    try {
      // 探测顺序保持便宜：只读文件头做编码分类，找到新式样本即返回，由断言验证几何。
      const head = readHeadBytes(file);
      if (!head.includes("SCH_901000")) return file;
    } catch {
      // 不可读样本不进入选择。
    }
  }
  return undefined;
}

function listXtFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(item);
      else if (entry.name.endsWith(".x_t")) files.push(item);
    }
  };
  walk(root);
  return files;
}

function readHeadBytes(file: string): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const size = Math.min(fstatSync(fd).size, 64 * 1024);
    const buffer = new Uint8Array(size);
    readSync(fd, buffer, 0, size, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}
