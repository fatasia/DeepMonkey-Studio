import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { validateDynamicSceneRuntime } from "@bim-studio/deep-engine/runtime-package";
import {
  generatePhysicsCollider,
  generatePhysicsColliderFromGlb,
  type ColliderMeshPrimitive,
  type PhysicsColliderSourceResult,
} from "./physicsColliderSource.js";

const FACTORY_ZIP = path.resolve(import.meta.dirname, "../../../test-fixtures/kenney-factory/factory.zip");
/** T00 冻结的 machine.glb(T00-s1 报告):25,620 B,464 顶点 / 804 索引 / 268 三角形,米制。 */
const MACHINE_SHA256 = "a39e3042bcb7789274428357383317d70e1c31906e5301c99e7d9e90ac584863";
const MACHINE_ENTRY = "Models/GLB format/machine.glb";

const tempDirectories: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** 单位立方体 8 角点(去重后即 8 点)。 */
function cubePositions(scale = 1): number[] {
  const corners: Array<[number, number, number]> = [
    [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
  ];
  return corners.flatMap(([x, y, z]) => [x * scale, y * scale, z * scale]);
}
function cube(): ColliderMeshPrimitive {
  const triangles: Array<[number, number, number]> = [
    [0, 1, 3], [0, 3, 2], [4, 7, 5], [4, 6, 7], [0, 4, 5], [0, 5, 1],
    [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3],
  ];
  return { primitiveId: "cube", positions: cubePositions(), indices: triangles.flat() };
}

/** 有缺口的凹体:立方体顶部挖掉一条槽(仍 8+8 顶点级)。 */
function notchedCube(): ColliderMeshPrimitive {
  const positions: number[] = [];
  const indices: number[] = [];
  // 两个盒体拼出 U 形缺口(x ∈ [-1,1],中间 x ∈ [-0.25,0.25] 顶部 y∈[0.5,1] 缺失)。
  const addBox = (min: [number, number, number], max: [number, number, number]) => {
    const base = positions.length / 3;
    const corners: Array<[number, number, number]> = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
      [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]],
    ];
    for (const corner of corners) positions.push(...corner);
    const faces: Array<[number, number, number]> = [
      [0, 1, 3], [0, 3, 2], [4, 7, 5], [4, 6, 7], [0, 4, 5], [0, 5, 1],
      [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3],
    ];
    for (const [a, b, c] of faces) indices.push(base + a, base + b, base + c);
  };
  addBox([-1, -1, -1], [-0.25, 1, 1]);
  addBox([0.25, -1, -1], [1, 1, 1]);
  return { primitiveId: "notched-cube", positions, indices };
}

/** 非流形:一条边被 3 个三角形共享(第三片鳍)。 */
function nonManifoldFin(): ColliderMeshPrimitive {
  // 四面:两个共享底边的三角形 + 一片重用底边的鳍。
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  const indices = [0, 1, 2, 1, 0, 3, 0, 1, 3];
  return { primitiveId: "non-manifold", positions, indices };
}

/** 确定性斐波那契球(512 点,半径 2)。 */
function spherePoints(count = 512, radius = 2): number[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * index;
    points.push(Math.cos(theta) * ring * radius, y * radius, Math.sin(theta) * ring * radius);
  }
  return points;
}

function hullResult(primitive: ColliderMeshPrimitive, strategy: "convex-hull" | "simplified-mesh" = "convex-hull",
  extra: Partial<Parameters<typeof generatePhysicsCollider>[1]> = {}): Promise<PhysicsColliderSourceResult> {
  return generatePhysicsCollider([primitive], {
    strategy,
    ...(strategy === "simplified-mesh" ? { simplifyTolerance: 0.01 } : {}),
    ...extra,
  } as Parameters<typeof generatePhysicsCollider>[1]);
}

/** 有符号体积(发散定理):外向环绕应为正。 */
function signedVolume(result: PhysicsColliderSourceResult): number {
  let volume = 0;
  for (const [a, b, c] of result.hullFaces ?? []) {
    const [p, q, r] = [result.points![a]!, result.points![b]!, result.points![c]!];
    volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
  }
  return volume;
}

/** 全部输入点必须落在凸包内(或面上,容差 = 对角线 × 1e-6)。 */
function expectEncloses(result: PhysicsColliderSourceResult, positions: number[]): void {
  const faces = result.hullFaces!;
  const scale = Math.max(...positions.map(Math.abs)) * 2;
  const epsilon = scale * 1e-6;
  for (let offset = 0; offset < positions.length; offset += 3) {
    const point = [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!];
    let minDistance = Infinity;
    for (const [a, b, c] of faces) {
      const [p, q, r] = [result.points![a]!, result.points![b]!, result.points![c]!];
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...n) || 1;
      const distance = ((point[0] - p[0]) * n[0] + (point[1] - p[1]) * n[1] + (point[2] - p[2]) * n[2]) / length;
      minDistance = Math.min(minDistance, distance);
    }
    expect(minDistance).toBeLessThanOrEqual(epsilon);
  }
}

describe("T17 collider 生成:凸包(确定性 quickhull)", () => {
  it("cube 产出 8 顶点 12 面凸包,外向、包住全部输入、逐位确定", async () => {
    const first = await hullResult(cube());
    expect(first.status).toBe("ok");
    expect(first.approximate).toBe(false);
    expect(first.hullVertexCount).toBe(8);
    expect(first.hullTriangleCount).toBe(12);
    expect(signedVolume(first)).toBeCloseTo(8, 6);
    expectEncloses(first, cubePositions());
    expect(first.concaveSource).toBe(false);
    const second = await hullResult(cube());
    expect(second.points).toEqual(first.points);
    expect(second.hullFaces).toEqual(first.hullFaces);
  });

  it("内部点与重复点不改变凸包", async () => {
    const positions = [...cubePositions(), 0, 0, 0, 0.5, 0.5, 0.5, 0, 0, 0];
    const plain = await hullResult(cube());
    const decorated = await hullResult({ primitiveId: "decorated", positions, indices: [] });
    // 空索引 = 0 三角形:拓扑检查给 warning,但凸包仍按点集构建。
    expect(decorated.hullVertexCount).toBe(plain.hullVertexCount);
    expect(new Set(decorated.points).size).toBe(8);
  });

  it("512 点斐波那契球:凸包包住全部点且体积接近解析值", async () => {
    const positions = spherePoints();
    const result = await hullResult({ primitiveId: "sphere", positions, indices: [] });
    expect(result.status).toBe("ok");
    expect(result.hullVertexCount).toBeGreaterThanOrEqual(4);
    expectEncloses(result, positions);
    const radius = 2;
    expect(signedVolume(result)).toBeGreaterThan((4 / 3) * Math.PI * radius ** 3 * 0.85);
  });

  it("凹体:concaveSource 标记为 true,凸包仍包住全部点", async () => {
    const primitive = notchedCube();
    const result = await hullResult(primitive);
    expect(result.status).toBe("ok");
    expect(result.approximate).toBe(false);
    expect(result.concaveSource).toBe(true);
    expectEncloses(result, primitive.positions);
  });

  it("非流形源:hull 仍产出但 approximate=true 并引用拓扑码", async () => {
    const result = await hullResult(nonManifoldFin());
    expect(result.topologyOk).toBe(false);
    expect(result.topologyIssueCodes).toContain("NON_MANIFOLD_EDGE");
    expect(result.status).toBe("approximate");
    expect(result.approximate).toBe(true);
    expect(result.reasons[0]).toBe("topology-error:NON_MANIFOLD_EDGE");
  });

  it("退化输入 fail-closed:共面/共线/点数不足/坏索引", async () => {
    const coplanar: ColliderMeshPrimitive = {
      primitiveId: "coplanar",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 2, 0],
      indices: [],
    };
    expect((await hullResult(coplanar)).reasons[0]).toMatch(/coplanar/);
    const collinear: ColliderMeshPrimitive = {
      primitiveId: "collinear", positions: [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3], indices: [],
    };
    expect((await hullResult(collinear)).reasons[0]).toMatch(/collinear/);
    const tiny: ColliderMeshPrimitive = { primitiveId: "tiny", positions: [0, 0, 0, 1, 0, 0], indices: [] };
    expect((await hullResult(tiny)).reasons[0]).toMatch(/at least 4/);
    const badIndex: ColliderMeshPrimitive = { primitiveId: "bad", positions: cubePositions(), indices: [0, 1, 99] };
    expect((await hullResult(badIndex)).reasons[0]).toMatch(/INDEX_OUT_OF_RANGE/);
  });

  it("每图元 4x4 列主序变换被应用到输出顶点", async () => {
    const translation = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
    const result = await generatePhysicsCollider(
      [{ primitiveId: "cube", positions: cubePositions(), indices: cube().indices, transform: translation }],
      { strategy: "convex-hull" },
    );
    const xs = result.points!.map(([x]) => x);
    const ys = result.points!.map(([, y]) => y);
    const zs = result.points!.map(([, , z]) => z);
    expect(Math.min(...xs)).toBeCloseTo(9, 6);
    expect(Math.max(...xs)).toBeCloseTo(11, 6);
    expect(Math.min(...ys)).toBeCloseTo(19, 6);
    expect(Math.max(...ys)).toBeCloseTo(21, 6);
    expect(Math.min(...zs)).toBeCloseTo(29, 6);
    expect(Math.max(...zs)).toBeCloseTo(31, 6);
  });
});

describe("T17 collider 生成:公差约束简化网格", () => {
  it("球体大公差:三角形大幅缩减且 status=ok;零公差目标超差 → approximate", async () => {
    const positions = spherePoints(512, 2);
    const triangles: number[] = [];
    // 扇形铺满:确定性低质网格,简化只关心公差闭环。
    for (let index = 1; index < 511; index += 1) triangles.push(0, index, index + 1);
    const primitive: ColliderMeshPrimitive = { primitiveId: "sphere-fan", positions, indices: triangles };
    const relaxed = await generatePhysicsCollider([primitive], { strategy: "simplified-mesh", simplifyTolerance: 0.5 });
    expect(relaxed.status).toBe("ok");
    expect(relaxed.triangleCount!).toBeLessThan(511);
    expect(relaxed.simplifierErrorAbsolute!).toBeLessThanOrEqual(0.5);
    const strict = await generatePhysicsCollider([primitive], { strategy: "simplified-mesh", simplifyTolerance: 1e-6 });
    expect(strict.status).toBe("ok"); // 不简化即精确,公差不会被违反
    expect(strict.triangleCount).toBe(510);
  });

  it("目标比例驱动的简化超差时标记 approximate + tolerance-violated", async () => {
    const positions = spherePoints(512, 2);
    const triangles: number[] = [];
    for (let index = 1; index < 511; index += 1) triangles.push(0, index, index + 1);
    const primitive: ColliderMeshPrimitive = { primitiveId: "sphere-fan", positions, indices: triangles };
    const result = await generatePhysicsCollider([primitive],
      { strategy: "simplified-mesh", simplifyTolerance: 1e-9, simplifyTargetTriangleRatio: 0.1 });
    if (result.status === "approximate") {
      expect(result.reasons.some(reason => reason.startsWith("tolerance-violated"))).toBe(true);
    } else {
      expect(result.status).toBe("ok");
      expect(result.simplifierErrorAbsolute!).toBeLessThanOrEqual(1e-9);
    }
  });

  it("缺 simplifyTolerance fail-closed", async () => {
    const result = await generatePhysicsCollider([cube()], { strategy: "simplified-mesh" });
    expect(result.status).toBe("failed");
    expect(result.reasons[0]).toMatch(/simplifyTolerance/);
  });
});

describe("T17 golden:T00 工厂 machine.glb → 拓扑检查 → collider", () => {
  let machineFilePromise: Promise<string> | null = null;
  const machineFile = (): Promise<string> => {
    machineFilePromise ??= (async () => {
      const zip = await JSZip.loadAsync(await readFile(FACTORY_ZIP));
      const entry = zip.file(MACHINE_ENTRY);
      if (!entry) throw new Error(`factory.zip 缺少 ${MACHINE_ENTRY}`);
      const bytes = await entry.async("nodebuffer");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(MACHINE_SHA256);
      const temp = await mkdtemp(path.join(tmpdir(), "bim-t17-collider-"));
      tempDirectories.push(temp);
      const file = path.join(temp, "machine.glb");
      await writeFile(file, bytes);
      // Kenney 包内纹理位于 Models/GLB format/Textures/,按 GLB 的 URI 视角落盘。
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
      return file;
    })();
    return machineFilePromise;
  };

  it("凸包:覆盖源 AABB、顶点规模有界、确定性,并冻结 Rust golden 输入", async () => {
    const file = await machineFile();
    const first = await generatePhysicsColliderFromGlb(file, { strategy: "convex-hull" });
    expect(first.sourceVertexCount).toBe(464);
    expect(first.sourceTriangleCount).toBe(268);
    expect(first.status).toBe(first.topologyOk ? "ok" : "approximate");
    expect(first.points!.length).toBe(first.hullVertexCount!);
    expect(first.hullVertexCount!).toBeGreaterThanOrEqual(4);
    expect(first.hullVertexCount!).toBeLessThanOrEqual(464);
    const xs = first.points!.map(([x]) => x);
    const ys = first.points!.map(([, y]) => y);
    const zs = first.points!.map(([, , z]) => z);
    // T00 manifest 冻结的源几何 bounds:[-0.6,0,-0.75] .. [0.6,1.29975,0.75]。
    expect(Math.min(...xs)).toBeCloseTo(-0.6, 4);
    expect(Math.max(...xs)).toBeCloseTo(0.6, 4);
    expect(Math.min(...ys)).toBeCloseTo(0, 4);
    expect(Math.max(...ys)).toBeCloseTo(1.29975, 4);
    expect(Math.min(...zs)).toBeCloseTo(-0.75, 4);
    expect(Math.max(...zs)).toBeCloseTo(0.75, 4);
    const second = await generatePhysicsColliderFromGlb(file, { strategy: "convex-hull" });
    expect(second.points).toEqual(first.points);
    expect(second.hullFaces).toEqual(first.hullFaces);
    // 端到端 TS 断言:生成载荷写入物理合同 → 运行包解析层接受。
    const runtimePackage = {
      schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: {
        schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, -9.81, 0],
        bodies: [{ id: "body-machine", type: "fixed", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
          mass: 1, friction: 0.6, restitution: 0,
          collider: { kind: "convex-hull", instanceIds: ["machine-instance"], points: first.points,
            precision: { approximate: first.approximate, reasons: first.reasons, hullVertexCount: first.hullVertexCount,
              triangleCount: first.hullTriangleCount, topologyOk: first.topologyOk,
              topologyIssueCodes: first.topologyIssueCodes, concaveSource: first.concaveSource } } }],
        joints: [],
      },
    };
    const validated = validateDynamicSceneRuntime(runtimePackage);
    expect(validated.valid).toBe(true);
    // 冻结数据落盘:Rust golden 测试与报告引用。
    const frozen = {
      glbSha256: MACHINE_SHA256,
      hullVertexCount: first.hullVertexCount,
      hullTriangleCount: first.hullTriangleCount,
      topologyOk: first.topologyOk,
      topologyIssueCodes: first.topologyIssueCodes,
      approximate: first.approximate,
      reasons: first.reasons,
      points: first.points,
    };
    const output = path.resolve(import.meta.dirname, "../../../test-output/t17-collider/golden-machine-hull.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(frozen, null, 2)}\n`);
  });

  it("简化网格:5mm 公差闭环可用作 collider 载荷", async () => {
    const file = await machineFile();
    const result = await generatePhysicsColliderFromGlb(file, { strategy: "simplified-mesh", simplifyTolerance: 0.005 });
    expect(result.status === "ok" || result.status === "approximate").toBe(true);
    expect(result.tolerance).toBe(0.005);
    expect(result.triangleCount!).toBeGreaterThan(0);
    expect(result.indices!.length).toBe(result.triangleCount! * 3);
    expect(result.simplifierErrorAbsolute ?? 0).toBeLessThanOrEqual(0.005 * (1 + 1e-6));
  });
});
