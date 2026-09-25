import { existsSync, fstatSync, openSync, readdirSync, readSync, closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCylinderFromCoaxialCircles,
  inferCylinderSpanFromCircles,
  parseXtTextDocument,
  resolveGenericMaxBytes,
  tessellateCylinderPatch,
  tessellatePlanePatch,
  tessellateSphere,
  XT_ANGULAR_SEGMENTS,
  XT_GENERIC_MAX_BYTES_CEILING,
  XT_GENERIC_MAX_BYTES_ENV,
  XtGenericSegmentError,
} from "./index.js";
import { buildSyntheticXtText } from "./testing.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cadconvertPath = join(repoRoot, "data/external-assets/format-fixtures/x_t/cadconvert-small.x_t");
const samplesRoot = join(repoRoot, "data/external-assets/industrial-format-plan/samples/downloaded/x_t");

const BOX_RECORDS = [
  // 平面盒的 6 个面：pnt normal 辅助向量 ref；辅助向量语义未定，这里放第三组正交轴。
  "52 255 1 1 0 0 0 0 0  0 0 0  0 0 1  1 0 0  0 1 0",
  "52 255 2 1 0 0 0 0 0  10 0 0  0 0 1  1 0 0  0 1 0",
  "52 255 3 1 0 0 0 0 0  0 0 0  0 1 0  0 0 1  1 0 0",
  "52 255 4 1 0 0 0 0 0  0 5 0  0 1 0  0 0 1  1 0 0",
  "52 255 5 1 0 0 0 0 0  0 0 0  1 0 0  0 1 0  0 0 1",
  "52 255 6 1 0 0 0 0 0  0 0 10  1 0 0  0 1 0  0 0 1",
  // 圆柱销：柱面 + 两端同轴圆边（推断轴向范围）。
  "53 255 20 1 0 0 0 0 0  10 2.5 5  0 0 1  1 0 0  2",
  "31 255 21 1 0 0 0 0 0  10 2.5 0  0 0 1  1 0 0  2",
  "31 255 22 1 0 0 0 0 0  10 2.5 10  0 0 1  1 0 0  2",
  // 圆锥（KH）与球（SPH）。
  "55 255 40 1 0 0 0 0 0  20 0 0  0 0 1  1 0 0  .866  3",
  "57 255 50 1 0 0  30 30 30  4",
  // 变换：单位旋转 + 平移。
  "100 255 60 1 0 0  1 0 0 0 1 0 0 0 1  5 0 0",
].join("\n");

describe("generic X_T text reader", () => {
  it("parses synthetic plane box, cylinder pin, cone and sphere with entity ids", () => {
    const document = parseXtTextDocument(buildSyntheticXtText({ schema: "SCH_999999_20000", records: BOX_RECORDS }));
    expect(document.header.encodingClass).toBe("format-text");
    expect(document.header.identificationSchema).toBe("SCH_999999_20000_1300");
    expect(document.planes).toHaveLength(6);
    expect(document.cylinders).toHaveLength(1);
    expect(document.cones).toHaveLength(1);
    expect(document.spheres).toHaveLength(1);
    expect(document.circles).toHaveLength(2);
    expect(document.transforms).toHaveLength(1);

    const cylinder = document.cylinders[0]!;
    expect(cylinder.entityId).toBe(20);
    expect(cylinder.radius).toBeCloseTo(2, 10);
    expect(cylinder.axis).toEqual([0, 0, 1]);
    const cone = document.cones[0]!;
    expect(cone.cosineAngle).toBeCloseTo(0.866, 10);
    expect(cone.radius).toBeCloseTo(3, 10);
    const sphere = document.spheres[0]!;
    expect(sphere.center).toEqual([30, 30, 30]);
    expect(sphere.radius).toBeCloseTo(4, 10);
    const transform = document.transforms[0]!;
    expect(transform.entityId).toBe(60);
    expect(transform.translation).toEqual([5, 0, 0]);
  });

  it("tessellates each family into indexed triangle meshes", () => {
    const document = parseXtTextDocument(buildSyntheticXtText({ schema: "SCH_999999_20000", records: BOX_RECORDS }));
    const plane = tessellatePlanePatch(document.planes[0]!, { u: 10, v: 5 });
    expect(plane.triangleCount).toBe(2);
    expect(plane.positions.length).toBe(12);

    const span = inferCylinderSpanFromCircles(document.cylinders[0]!, document.circles);
    expect(span).toEqual({ start: -5, end: 5 });
    const cylinder = tessellateCylinderPatch(document.cylinders[0]!, span!);
    expect(cylinder.triangleCount).toBe(XT_ANGULAR_SEGMENTS * 2);
    expect(cylinder.indices.every((index) => index < cylinder.positions.length / 3)).toBe(true);

    const sphere = tessellateSphere(document.spheres[0]!);
    expect(sphere.triangleCount).toBe(XT_ANGULAR_SEGMENTS * 32 * 2);

    // 重构路径：没有柱面记录时也能用一对同轴圆边得到等价圆柱参数。
    const reconstructed = buildCylinderFromCoaxialCircles(document.circles[0]!, document.circles[1]!);
    expect(reconstructed?.radius).toBeCloseTo(2, 10);
    expect(reconstructed?.span).toEqual({ start: 0, end: 10 });
  });

  it("records schema without rejecting and flags legacy baseline encoding", () => {
    const legacy = parseXtTextDocument(buildSyntheticXtText({
      schema: "SCH_1901254_19008", identificationSchema: "SCH_901000_90080", records: "31 255 1 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 1 .01",
    }));
    expect(legacy.header.encodingClass).toBe("legacy-baseline");
    expect(legacy.circles).toHaveLength(0);
    expect(legacy.census).toHaveProperty("31");

    const unknownSchema = parseXtTextDocument(buildSyntheticXtText({
      schema: "SCH_4000000_40000", identificationSchema: "SCH_4000000_40000_9999", records: BOX_RECORDS,
    }));
    expect(unknownSchema.header.encodingClass).toBe("format-text");
    expect(unknownSchema.planes).toHaveLength(6);
  });

  it("rejects damaged headers and enforces the size ceiling", () => {
    expect(() => parseXtTextDocument(new TextEncoder().encode("not an x_t file"))).toThrow(XtGenericSegmentError);
    expect(() => parseXtTextDocument(new Uint8Array(17 * 1024 * 1024))).toThrow(XtGenericSegmentError);
    // 上限只能通过显式参数或环境变量放宽，且 64MB 是硬顶。
    const relaxed = parseXtTextDocument(buildSyntheticXtText({ schema: "SCH_999999_20000", records: BOX_RECORDS }), XT_GENERIC_MAX_BYTES_CEILING);
    expect(relaxed.planes).toHaveLength(6);
    expect(resolveGenericMaxBytes({ [XT_GENERIC_MAX_BYTES_ENV]: "64" })).toBe(64);
    // 未超硬顶的取值照常生效；超过 64MB 的请求被钳制到硬顶。
    expect(resolveGenericMaxBytes({ [XT_GENERIC_MAX_BYTES_ENV]: "1024" })).toBe(1024);
    expect(resolveGenericMaxBytes({ [XT_GENERIC_MAX_BYTES_ENV]: "999999999" })).toBe(XT_GENERIC_MAX_BYTES_CEILING);
    expect(resolveGenericMaxBytes({})).toBe(16 * 1024 * 1024);
  });

  const cadconvertReady = existsSync(cadconvertPath);
  it.runIf(cadconvertReady)("reproduces validated entity counts on the signed real sample", async () => {
    const document = parseXtTextDocument(await readFile(cadconvertPath));
    expect(document.header.identificationSchema).toBe("SCH_2401231_20000_1300");
    expect(document.header.application).toBe("SolidWorks 2013-2012270");
    // 与已签署旋转体子集的探测口径一致：10 条圆边、1 个圆环面。
    expect(document.circles).toHaveLength(10);
    expect(document.tori).toHaveLength(1);
    expect(document.tori[0]?.minorRadius).toBeCloseTo(0.007, 6);
    expect(document.planes.length).toBeGreaterThan(0);
  });

  const corpusSamples = cadconvertReady && existsSync(samplesRoot) ? collectSamples(samplesRoot) : [];
  it.runIf(corpusSamples.legacy.length > 0 && corpusSamples.modern.length > 0)("reads real corpus samples of both encodings", async () => {
    const modern = parseXtTextDocument(await readFile(corpusSamples.modern[0]!));
    expect(modern.header.encodingClass).toBe("format-text");
    expect(modern.circles.length + modern.planes.length + modern.tori.length).toBeGreaterThan(0);
    const legacy = parseXtTextDocument(await readFile(corpusSamples.legacy[0]!));
    expect(legacy.header.encodingClass).toBe("legacy-baseline");
    expect(legacy.circles).toHaveLength(0);
    // 旧基线编码只记录事实，不伪造几何。
    expect(legacy.census).toHaveProperty("31");
  });
});

function collectSamples(root: string): { modern: string[]; legacy: string[] } {
  const modern: string[] = [];
  const legacy: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith(".x_t")) continue;
      try {
        const head = readHead(path);
        (head.includes("SCH_901000") ? legacy : modern).push(path);
      } catch {
        // 不可读样本进不了清单，由回归矩阵报告失败原因。
      }
    }
  };
  walk(root);
  return { modern, legacy };
}

function readHead(path: string): string {
  // 编码分类只需要头部；legacy 判定标记总是位于文件前部。
  const buffer = readFileSyncSlice(path, 64 * 1024);
  return new TextDecoder("latin1").decode(buffer);
}

function readFileSyncSlice(path: string, length: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(fstatSync(fd).size, length);
    const buffer = new Uint8Array(size);
    readSync(fd, buffer, 0, size, 0);
    return buffer;
  } finally {
    closeSync(fd);
  }
}
