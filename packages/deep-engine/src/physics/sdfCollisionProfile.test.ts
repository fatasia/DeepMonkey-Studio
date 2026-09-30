import { describe, expect, it } from "vitest";
import { sampleSdfGrid } from "./sdfGrid.js";
import {
  SDF_COLLISION_PROFILE_DEFAULT_ENABLED, SDF_QUERY_LCG_SEED, SDF_QUERY_NAN_BITS,
  SDF_QUERY_PARAMS_BYTES, createSdfCollisionProfile, createSdfQueryPointStream,
  deriveSdfProfileDistanceBound, estimateSdfCollisionMemory, fingerprintSdfQuerySamples,
  isSdfQueryNanBitPattern, packSdfQueryParams, sampleSdfCollision,
} from "./sdfCollisionProfile.js";
import { GRID_CELL_SIZE, GRID_DIMENSIONS, GRID_ORIGIN, loadFixtureGrid } from "./sdfCollisionTruthFixture.js";

/** 跨端逐位指纹(TS 镜像与 native sdf_collision_profile_truth.rs 同字面量)。 */
const PINNED_CROSS_LANGUAGE_FINGERPRINT = "9d5c2f7210ed7244";

describe("A2 SDF 碰撞 profile(opt-in 合同)", () => {
  it("opt-in 默认关:默认常量为 false,enabled 非字面量 true 一律拒绝创建", () => {
    expect(SDF_COLLISION_PROFILE_DEFAULT_ENABLED).toBe(false);
    const grid = loadFixtureGrid();
    expect(() => createSdfCollisionProfile({ enabled: false as unknown as true, grid })).toThrow(/默认关闭/);
    expect(() => createSdfCollisionProfile({ enabled: undefined as unknown as true, grid })).toThrow(/默认关闭/);
  });

  it("显式开启后分类正确:实体 penetrating、凹域 free、contactSkin 收缩生效", () => {
    const profile = createSdfCollisionProfile({ enabled: true, grid: loadFixtureGrid() });
    expect(profile.classify([0.375, 0.375, 0.375])).toBe("penetrating");
    expect(profile.classify([2.375, 2.375, 0.375])).toBe("free");
    const nearSurface = profile.sample([1.5, 1.05, 0.5]);
    expect(nearSurface.inDomain).toBe(true);
    const skinned = createSdfCollisionProfile({
      enabled: true, grid: profile.grid, contactSkin: Math.abs(nearSurface.distance) + 0.01,
    });
    expect(skinned.classify([1.5, 1.05, 0.5])).toBe("free");
  });

  it("域外 fail-closed:classify 抛错、sample 返回 NaN + 状态位 quiet NaN", () => {
    const profile = createSdfCollisionProfile({ enabled: true, grid: loadFixtureGrid() });
    expect(() => profile.classify([10, 10, 10])).toThrow(/fail-closed/);
    const outside = sampleSdfCollision(profile.grid, [10, 10, 10]);
    expect(outside.inDomain).toBe(false);
    expect(Number.isNaN(outside.distance)).toBe(true);
    const bits = new DataView(new Float32Array([outside.distance]).buffer).getUint32(0, true);
    expect(isSdfQueryNanBitPattern(bits)).toBe(true);
    expect(SDF_QUERY_NAN_BITS).toBe(0x7fc00000);
  });

  it("CPU 镜像与既有 sampleSdfGrid 数值一致(≤1e-6,LCG 采样 + 角点)", () => {
    const grid = loadFixtureGrid();
    const points = [...createSdfQueryPointStream(grid, 256),
      GRID_ORIGIN, [3.625, 3.625, 3.625], [0.375, 0.375, 0.375]] as const;
    let worst = 0;
    let skippedBoundary = 0;
    for (const point of points) {
      const mirror = sampleSdfCollision(grid, point);
      // 既有 CPU 查询按 f64 判域,f32 合同允许的恰在界上的点它可能拒绝;
      // 该情形只允许发生在域边界(镜像判内、参考判外)。
      try {
        const reference = sampleSdfGrid(grid, point);
        worst = Math.max(worst, Math.abs(mirror.distance - reference));
      } catch {
        const coords = point.map((value, axis) => (value - grid.origin[axis]!) / grid.cellSize);
        expect(coords.some((value, axis) => Math.abs(value - (grid.dimensions[axis]! - 1)) < 1e-6)).toBe(true);
        skippedBoundary += 1;
      }
    }
    expect(skippedBoundary).toBeLessThanOrEqual(4);
    expect(worst).toBeLessThan(1e-6);
  });

  it("同 seed 重放逐位一致(镜像 + 指纹稳定)", () => {
    const grid = loadFixtureGrid();
    const run = () => createSdfQueryPointStream(grid, 512)
      .map(point => sampleSdfCollision(grid, point));
    const first = run();
    const second = run();
    expect(fingerprintSdfQuerySamples(second)).toBe(fingerprintSdfQuerySamples(first));
    for (let i = 0; i < first.length; i++) {
      expect(second[i]!.distance).toBe(first[i]!.distance);
      expect(second[i]!.gradient).toEqual(first[i]!.gradient);
    }
  });

  it("距离上界派生自体素采样误差(√3/2·cellSize)", () => {
    const grid = loadFixtureGrid();
    expect(deriveSdfProfileDistanceBound(grid)).toBeCloseTo(Math.sqrt(3) / 2 * GRID_CELL_SIZE, 12);
    expect(grid.maxSamplingError).toBeCloseTo(0.21650635094610965, 12);
  });

  it("内存预算:16×16×8 = 2048 cells 精确字节,超限 fail-closed", () => {
    const memory = estimateSdfCollisionMemory(GRID_DIMENSIONS, 4096);
    expect(memory).toEqual({
      cells: 2048, fieldBytes: 8_192, queryBufferBytes: 65_536, resultBufferBytes: 65_536,
      statusBufferBytes: 16_384, paramsBytes: SDF_QUERY_PARAMS_BYTES, uploadBytes: 73_776, totalBytes: 155_696,
    });
    expect(SDF_QUERY_PARAMS_BYTES).toBe(48);
    expect(() => estimateSdfCollisionMemory([65, 64, 64], 16)).toThrow(/预算/);
    expect(() => estimateSdfCollisionMemory(GRID_DIMENSIONS, 65_537)).toThrow(/数量/);
  });

  it("uniform 打包 48 B 布局逐字段回读(与 WGSL QueryParams 互钉)", () => {
    const grid = loadFixtureGrid();
    const buffer = packSdfQueryParams(grid, 1234, 0.05);
    expect(buffer.byteLength).toBe(48);
    const view = new DataView(buffer);
    expect(view.getFloat32(0, true)).toBe(GRID_ORIGIN[0]);
    expect(view.getFloat32(4, true)).toBe(GRID_ORIGIN[1]);
    expect(view.getFloat32(8, true)).toBe(GRID_ORIGIN[2]);
    expect(view.getFloat32(12, true)).toBe(GRID_CELL_SIZE);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint32(20, true)).toBe(16);
    expect(view.getUint32(24, true)).toBe(8);
    expect(view.getUint32(28, true)).toBe(1234);
    expect(view.getFloat32(32, true)).toBeCloseTo(0.05, 6);
  });

  it("跨端逐位指纹钉死(与 native sdf_collision_profile_truth.rs 同一字面量)", () => {
    const grid = loadFixtureGrid();
    const samples = createSdfQueryPointStream(grid, 4096, SDF_QUERY_LCG_SEED)
      .map(point => sampleSdfCollision(grid, point));
    expect(fingerprintSdfQuerySamples(samples)).toBe(PINNED_CROSS_LANGUAGE_FINGERPRINT);
  });
});
