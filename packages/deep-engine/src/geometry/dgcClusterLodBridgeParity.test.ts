import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calibrateBakeErrorToDisplacement, dgcDagToClusterLod } from "./dgcClusterLodBridge.js";
import { decodeDgc } from "./dgcLoader.js";
import { b64ToBytes, encodeDgc, goldenToEncoderDag, type GoldenJson } from "./dgcEncoder.testUtils.js";
import { bakeClusterLodDag } from "../rayTracing/clusterLodBake.js";

// 黄金 fixture(与 dgcLoader.test 共享同一份逐位对拍存档):
// packages/deep-engine/src/geometry → packages/deep-engine-native/geometry_dag/tests/fixtures。
const FIXTURES = new URL("../../../deep-engine-native/geometry_dag/tests/fixtures/", import.meta.url);
const loadGolden = (name: string): GoldenJson =>
  JSON.parse(readFileSync(new URL(`${name}.golden.json`, FIXTURES), "utf8")) as GoldenJson;
const goldenGeometry = (json: GoldenJson) => ({
  positions: new Float32Array(b64ToBytes(json.input.positionsB64).buffer),
  indices: new Uint32Array(b64ToBytes(json.input.indicesB64).buffer),
});

describe("同源网格双臂结构对拍(decodeDgc→桥 vs bake,缺口 2 验收)", () => {
  for (const name of ["quick_sphere", "synthetic50k"] as const) {
    it(`aligns both arms on ${name} (structure + calibrated error domain)`, () => {
      const json = loadGolden(name);
      const geometry = goldenGeometry(json);
      const triangleTotal = geometry.indices.length / 3;

      // dgc 臂:golden(逐位存档)→ .dgc 字节 → decodeDgc → 桥。
      const decoded = decodeDgc(encodeDgc(goldenToEncoderDag(json)));
      const dgcArm = dgcDagToClusterLod(decoded, { geometryId: name });
      // bake 臂:同一源网格 → bake 参考实现(层数与 dgc 臂一致)。
      const bakeArm = bakeClusterLodDag({
        geometryId: name, vertices: geometry.positions, indices: geometry.indices,
        level0ClusterSize: 64, levelCount: json.levels.length,
      });

      // 身份与叶子总数:同源网格两臂必须一致,且都等于源三角形数。
      expect(dgcArm.dag.geometryId).toBe(name);
      expect(bakeArm.dag.geometryId).toBe(name);
      expect(dgcArm.dag.leafTriangleTotal).toBe(triangleTotal);
      expect(bakeArm.dag.leafTriangleTotal).toBe(triangleTotal);

      // 层级结构:层数一致;两臂逐层簇数严格下降;dgc 臂簇数与 golden 钉死。
      expect(dgcArm.dag.nodes.some((node) => node.level === json.levels.length - 1)).toBe(true);
      const countOf = (result: typeof dgcArm, level: number) =>
        result.dag.nodes.filter((node) => node.level === level).length;
      const goldenCounts = json.levels.map(
        (level) => b64ToBytes(level.clusterSourceSpansB64).length / 8,
      );
      for (let level = 0; level < json.levels.length; level++) {
        expect(countOf(dgcArm, level)).toBe(goldenCounts[level]!);
        expect(countOf(bakeArm, level)).toBeGreaterThan(0);
        if (level > 0) {
          expect(countOf(dgcArm, level)).toBeLessThan(countOf(dgcArm, level - 1)!);
          // bake 参考实现没有 dgc 的"不再下降即收束"停机,最深层簇数可停滞(实测
          // synthetic50k L3 停在 1)——语义差异如实断言为非增;dgc 臂保持严格下降。
          expect(countOf(bakeArm, level)).toBeLessThanOrEqual(countOf(bakeArm, level - 1)!);
        }
      }

      // 误差标量单调(合同硬门槛)两臂同构;dgc 臂层误差与 golden 逐值一致。
      const levelError = (result: typeof dgcArm, level: number) =>
        new Set(result.dag.nodes.filter((node) => node.level === level).map((node) => node.error));
      const dgcErrors: number[] = [], bakeErrors: number[] = [];
      for (let level = 0; level < json.levels.length; level++) {
        const dgcSet = levelError(dgcArm, level), bakeSet = levelError(bakeArm, level);
        expect(dgcSet.size).toBe(1);
        expect(bakeSet.size).toBe(1);
        const dgcLevelError = [...dgcSet][0]!;
        expect(dgcLevelError).toBe(json.levels[level]!.error);
        dgcErrors.push(dgcLevelError);
        bakeErrors.push([...bakeSet][0]!);
        if (level > 0) {
          expect(dgcErrors[level]!).toBeGreaterThan(dgcErrors[level - 1]!);
          expect(bakeErrors[level]!).toBeGreaterThan(bakeErrors[level - 1]!);
        }
      }

      // dgc 臂满射性:每个粗簇都有 children(黄金父表实测 coarse 全覆盖);
      // bake 臂 4:1 结构:level k 簇 c 的 children = level k-1 簇 4c..4c+3。
      const childrenOf = (result: typeof dgcArm, id: string) =>
        result.dag.nodes.find((node) => node.id === id)!.children;
      for (let level = 1; level < json.levels.length; level++) {
        const coarseCount = countOf(dgcArm, level);
        for (let cluster = 0; cluster < coarseCount; cluster++) {
          expect(childrenOf(dgcArm, `l${level}-c${cluster}`).length).toBeGreaterThan(0);
        }
        for (let cluster = 0; cluster < countOf(bakeArm, level); cluster++) {
          const expected = [0, 1, 2, 3]
            .map((offset) => `l${level - 1}-c${cluster * 4 + offset}`)
            .filter((id) => countOf(bakeArm, level - 1) > Number(id.slice(id.lastIndexOf("c") + 1)));
          expect(childrenOf(bakeArm, `l${level}-c${cluster}`)).toEqual(expected);
        }
      }

      // 包围体健全性:两臂全部节点有限且 min ≤ max。
      for (const arm of [dgcArm, bakeArm]) {
        for (const node of arm.dag.nodes) {
          for (let axis = 0; axis < 3; axis++) {
            expect(Number.isFinite(node.boundsMin[axis]!)).toBe(true);
            expect(Number.isFinite(node.boundsMax[axis]!)).toBe(true);
            expect(node.boundsMax[axis]!).toBeGreaterThanOrEqual(node.boundsMin[axis]!);
          }
        }
      }

      // 统一误差域对照(缺口 2 实证合同):bake cell 序列经 α 映射后与 dgc 累计位移
      // 同序且量级对齐。实测带(标定证据 G1BRIDGE2-error-calibration.json):
      // L1 相对真值 0.354~0.802 倍,末级累计 0.802~1.053 倍——单 α 模型精度合同,
      // 深层级系统性偏差已如实记录在常量注释,超带即标定漂移。
      const mapped = calibrateBakeErrorToDisplacement([0, ...bakeErrors.slice(1)]).slice(1);
      for (let index = 1; index < mapped.length; index++) expect(mapped[index]!).toBeGreaterThan(mapped[index - 1]!);
      expect(mapped[0]! / dgcErrors[1]!).toBeGreaterThanOrEqual(0.3);
      expect(mapped[0]! / dgcErrors[1]!).toBeLessThanOrEqual(0.9);
      const last = mapped.length - 1;
      expect(mapped[last]! / dgcErrors[dgcErrors.length - 1]!).toBeGreaterThanOrEqual(0.5);
      expect(mapped[last]! / dgcErrors[dgcErrors.length - 1]!).toBeLessThanOrEqual(1.25);
    });
  }
});
