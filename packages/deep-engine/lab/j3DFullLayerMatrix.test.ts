// J3-D-full 逐层矩阵 CPU 骨架测试:目录完整性、门绑定不变量、场景格展开、后处理期望生成确定性。
// 全部为 CPU 断言;GPU 实测证据由主线程 runner 回填,本测试不依赖 test-output。
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { J3_D_FULL_SCHEMA, J3_D_FULL_GATES, J3_D_FULL_LAYERS, REQUIRED_LAYER_GATE,
  DISPLAY_BYTE_LSB, HDR_STRICT_CHANNEL_ERROR, expandSceneCells, type J3DFullLayer,
  buildBloomExpectations, buildFogExpectations, buildDisplayExpectations,
  type J3DFullLayerId } from "./j3DFullLayerMatrix.js";
import type { BloomTextureFixture } from "./j3BloomTextureReference.js";
import type { FogProfileFixture } from "./j3FogProfileReference.js";

const root = path.join(fileURLToPath(new URL(import.meta.url)), "../../../..");
const readFixture = (relative: string): unknown =>
  JSON.parse(readFileSync(path.join(root, relative), "utf8"));

describe("J3-D-full 层目录与门绑定", () => {
  it("八个层、唯一 id、每层门都存在且绑定与必备表一致", () => {
    expect(J3_D_FULL_LAYERS).toHaveLength(8);
    expect(new Set(J3_D_FULL_LAYERS.map(layer => layer.id)).size).toBe(8);
    for (const layer of J3_D_FULL_LAYERS) {
      expect(J3_D_FULL_GATES[layer.gateId], `层 ${layer.id} 的门必须存在`).toBeDefined();
      expect(REQUIRED_LAYER_GATE[layer.id]).toBe(layer.gateId);
      expect(layer.evidenceDir.startsWith("test-output/interrupted-0930/")).toBe(true);
    }
  });

  it(".002 HDR 门与 display 字节门的全局唯一性与互斥不变量", () => {
    const gates = Object.values(J3_D_FULL_GATES);
    expect(gates.filter(gate => gate.hdr002Applicable).map(gate => gate.id))
      .toEqual(["hdr-flat-strict"]);
    expect(gates.filter(gate => gate.displayByteApplicable).map(gate => gate.id))
      .toEqual(["display-byte"]);
    // 1/255=0.00392 > 0.002:display 门若用于 HDR 层即放水,HDR 门若用于显示域即过严;两者不可互换。
    expect(DISPLAY_BYTE_LSB).toBeGreaterThan(HDR_STRICT_CHANNEL_ERROR);
    expect(DISPLAY_BYTE_LSB).toBeCloseTo(0.00392156862745098, 12);
  });

  it("已验证层指向的证据目录当前存在(引用完整性,不读内容)", () => {
    for (const layer of J3_D_FULL_LAYERS) {
      if (layer.status !== "verified-2026-09-30") continue;
      expect(existsSync(path.join(root, layer.evidenceDir, "evidence.json")),
        `${layer.id} 声称已验证但缺 evidence.json`).toBe(true);
    }
  });

  it("场景格展开:格数与身份全部来自冻结 fixture", () => {
    const geometry = readFixture("packages/deep-engine/fixtures/j3-geometry-depth-v1.json") as
      { cameras: readonly { id: string }[] };
    const bloom = readFixture("packages/deep-engine/fixtures/j3-bloom-texture-v1.json") as BloomTextureFixture;
    const fog = readFixture("packages/deep-engine/fixtures/j3-fog-profiles-v1.json") as FogProfileFixture;
    const display = readFixture("packages/deep-engine/fixtures/display-parity-v1.json") as Record<string, unknown>;
    const byId = new Map(J3_D_FULL_LAYERS.map(layer => [layer.id, layer]));
    const requireLayer = (id: J3DFullLayerId): J3DFullLayer => {
      const layer = byId.get(id);
      if (!layer) throw new Error(`missing layer ${id}`);
      return layer;
    };
    expect(expandSceneCells(requireLayer("geometry-coverage"), geometry).map(cell => cell.cellId))
      .toEqual(geometry.cameras.map(camera => camera.id));
    expect(expandSceneCells(requireLayer("post-bloom"), bloom)).toHaveLength(bloom.cases.length);
    const fogCells = expandSceneCells(requireLayer("post-fog"), fog);
    expect(fogCells).toHaveLength(fog.profiles.length + fog.nativeOnly.length);
    expect(fogCells.filter(cell => cell.hostScope === "web-only").map(cell => cell.cellId).sort())
      .toEqual(["exponential", "steps-min"]);
    expect(expandSceneCells(requireLayer("display"), display))
      .toHaveLength((display.colors as unknown[]).length);
  });
});

describe("后处理逐层 CPU 期望生成器(复用既有参考)", () => {
  const bloom = readFixture("packages/deep-engine/fixtures/j3-bloom-texture-v1.json") as BloomTextureFixture;
  const fog = readFixture("packages/deep-engine/fixtures/j3-fog-profiles-v1.json") as FogProfileFixture;
  const display = readFixture("packages/deep-engine/fixtures/display-parity-v1.json") as Record<string, unknown>;

  it("Bloom:每案例 web+native 双期望,digest 确定且跨构建稳定", () => {
    const first = buildBloomExpectations(bloom), second = buildBloomExpectations(bloom);
    expect(first.layerId).toBe("post-bloom");
    expect(first.gateId).toBe("post-half-store");
    expect(first.crossHostEqualityGate).toBe(false);
    expect(first.tolerances).toEqual({ absolute: 0.003, relative: 0.004 });
    expect(first.cells).toHaveLength(bloom.cases.length * 2);
    expect(second).toEqual(first);
    for (const cell of first.cells) {
      expect(cell.referenceDigest).toMatch(/^[0-9a-f]{16}$/);
      expect(cell.pixels).toBe(bloom.width * bloom.height);
    }
  });

  it("Fog:web 期望 CPU 生成,native 期望标记 frame 依赖且不伪造 digest", () => {
    const expectation = buildFogExpectations(fog);
    expect(expectation.layerId).toBe("post-fog");
    expect(expectation.tolerances).toEqual({ absolute: 0.003, relative: 0.004 });
    const webCells = expectation.cells.filter(cell => cell.host === "web");
    const nativeCells = expectation.cells.filter(cell => cell.host === "native");
    expect(webCells).toHaveLength(fog.profiles.length);
    for (const cell of webCells) expect(cell.referenceDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(nativeCells).toHaveLength((fog.profiles.length + fog.nativeOnly.length) * fog.nativeEyeY.length);
    for (const cell of nativeCells) {
      expect(cell.nativeFrameDependent).toBe(true);
      expect(cell.referenceDigest).toBeUndefined();
    }
  });

  it("Display:期望为门绑定与冻结色块身份,容差按字节门换算", () => {
    const expectation = buildDisplayExpectations(display);
    expect(expectation.gateId).toBe("display-byte");
    expect(expectation.tolerances.absolute).toBeCloseTo(DISPLAY_BYTE_LSB, 12);
    expect(expectation.cells).toHaveLength(8);
    expect(J3_D_FULL_SCHEMA).toBe("j3-d-full-layer-matrix-v1");
  });
});
