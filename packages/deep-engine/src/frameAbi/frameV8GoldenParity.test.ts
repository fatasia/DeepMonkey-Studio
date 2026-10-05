// B2 frame v8 双端逐字节 golden 对拍(TS 侧;审计差距 4,ts-rust-parity-audit-20261005 §5#4)。
// fixture 单源:fixtures/frame-abi/frame-v8-golden-parity-v1.json(生成器
// scripts/generateFrameV8GoldenParity.mts;Rust 侧 twin:
// deep-engine-native::frame_v8_golden_parity_tests 读同一文件逐字对拍)。
// 三点断言:①TS 真打包 == fixture ts.words(96 字逐字+SHA-256);②fixture 自身
// 一致性(schema 指纹/两端字数/Rust 段摘要复算);③双端共享语义段交叉关系
// (lightDirection 零保留取反/sunColor rgb 全等/exposure 相等,w 通道双语义按声明)。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CameraFrameHistory } from "../webgpu/cameraFrameHistory.js";
import { updatePbrFrameUniforms, type PbrFrameUniformResources, type PbrFrameUniformView } from "../webgpu/pbrFrameUniforms.js";
import type { PbrRendererFeatures } from "../webgpu/pbrRendererFeatures.js";
import type { PbrPrimaryDirectionalLight } from "../lighting/pbrSceneLighting.js";
import type { RtShadowRoute } from "../webgpu/rtShadowScheduling.js";
import { FRAME_ABI_CORE, FRAME_ABI_RUST_FLOATS, FRAME_ABI_SCHEMA_SHA256, FRAME_ABI_TS_FLOATS } from "./generated/frameLayout.js";
import { FRAME_UNIFORM_REUSED_WORDS, FRAME_UNIFORM_TOTAL_WORDS } from "./frameUniformSlotTable.js";

const FIXTURE_PATH = join(import.meta.dirname, "../../fixtures/frame-abi/frame-v8-golden-parity-v1.json");

interface GoldenCase {
  readonly id: string;
  readonly inputs: {
    readonly ts: { readonly view: PbrFrameUniformView; readonly width: number; readonly height: number;
      readonly forceCut: boolean; readonly frames: number;
      readonly primaryLight: PbrPrimaryDirectionalLight; readonly features: PbrRendererFeatures;
      readonly route: RtShadowRoute | null };
    readonly rust: { readonly aspect: number; readonly yaw: number;
      readonly directionalLighting: { readonly direction: number[]; readonly radiance: number[];
        readonly exposure: number; readonly shadows: boolean;
        readonly localLights?: readonly { readonly kind: string }[] } };
  };
  readonly ts: { readonly floats: number; readonly words: number[]; readonly sha256: string };
  readonly rust: { readonly floats: number; readonly words: number[] | null; readonly sha256: string | null };
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  readonly fixtureSchema: string; readonly frameAbiSchemaSha256: string; readonly cases: GoldenCase[];
};
const f32 = (value: number): number => Float32Array.from([value])[0]!;
const sha256OfWords = (words: readonly number[]): string =>
  createHash("sha256").update(Buffer.from(Float32Array.from(words).buffer)).digest("hex");
const stubQueue = { writeBuffer: () => undefined } as unknown as GPUQueue;

function repack(expected: GoldenCase["ts"]["words"], label: string): number[] {
  const input = fixture.cases.find(entry => entry.ts.words === expected)!.inputs.ts;
  const resources: PbrFrameUniformResources = {
    frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer, groundInstance: {} as GPUBuffer,
    frameData: new Float32Array(FRAME_UNIFORM_TOTAL_WORDS), outputData: new Float32Array(8),
    groundData: new Float32Array(36),
  };
  const history = new CameraFrameHistory();
  for (let index = 0; index < input.frames; index++) {
    const result = updatePbrFrameUniforms(stubQueue, history, input.view, input.width, input.height,
      index === 0 && input.forceCut, resources, input.primaryLight, input.features,
      input.route ?? undefined);
    history.commitFrame(result.history);
  }
  const words = Array.from(resources.frameData);
  for (let word = 0; word < words.length; word++) {
    expect(words[word], `${label} word ${word}`).toBe(expected[word]);
  }
  expect(sha256OfWords(words), `${label} sha256(f32-le)`).toBe(
    fixture.cases.find(entry => entry.ts.words === expected)!.ts.sha256);
  return words;
}

const coreAnchor = (name: string): { tsOffset: number; rustRow: number } => {
  const field = FRAME_ABI_CORE.find(entry => entry.name === name)!;
  return { tsOffset: field.tsOffset, rustRow: field.rustRow };
};

describe("frame v8 cross-language byte golden (B2, TS side of the Rust twin)", () => {
  it("fixture is pinned to the frame-abi schema fingerprint and dual-end word counts", () => {
    expect(fixture.fixtureSchema).toBe("deep-monkey.frame-v8-golden-parity.v1");
    expect(fixture.frameAbiSchemaSha256).toBe(FRAME_ABI_SCHEMA_SHA256);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3);
    for (const entry of fixture.cases) {
      expect(entry.ts.floats).toBe(FRAME_ABI_TS_FLOATS);
      expect(entry.rust.floats).toBe(FRAME_ABI_RUST_FLOATS);
      // 单源合同:Rust 段必须已由 cargo test frame_v8_golden_parity -- --ignored 填充。
      expect(entry.rust.words, `${entry.id}: run the ignored native filler test`).not.toBeNull();
      expect(entry.rust.sha256, `${entry.id}: run the ignored native filler test`).not.toBeNull();
      expect(sha256OfWords(entry.rust.words!), `${entry.id} rust sha256 recomputed`).toBe(entry.rust.sha256);
    }
  });

  it("layout anchors in the fixture equal the generated core-field offsets on both ends", () => {
    expect(coreAnchor("viewProjection")).toEqual({ tsOffset: 0, rustRow: 0 });
    expect(coreAnchor("lightViewProjection")).toEqual({ tsOffset: 48, rustRow: 4 });
    expect(coreAnchor("eye")).toEqual({ tsOffset: 64, rustRow: 8 });
    expect(coreAnchor("lightDirection")).toEqual({ tsOffset: 76, rustRow: 11 });
    expect(coreAnchor("sunColor")).toEqual({ tsOffset: 84, rustRow: 13 });
  });

  for (const entry of fixture.cases) {
    it(`case '${entry.id}': real packing is byte-identical to the golden 96 words`, () => {
      const words = repack(entry.ts.words, entry.id);
      const input = entry.inputs.ts;
      const rust = entry.rust.words!;
      // 借位台账两槽按输入语义复核(word 71 castShadow / word 89 RT 阴影开关位)。
      expect(words[FRAME_UNIFORM_REUSED_WORDS[0]!.word]).toBe(input.primaryLight.castShadow === false ? 0 : 1);
      expect(words[FRAME_UNIFORM_REUSED_WORDS[1]!.word]).toBe(
        input.features.rayTracedShadows && input.route?.channel !== "cascade" ? 1 : 0);
      // 交叉关系一:lightDirection xyz 全等(适配层把 TS surfaceToLightWorld(to-light)
      // 直喂 rust direction 后,两端打包值相等;与作者 travel direction 相差一符号)。
      // w 双语义:ts=environmentIntensity,rust=0 遗留闲道。
      const light = coreAnchor("lightDirection");
      for (let axis = 0; axis < 3; axis++) {
        expect(words[light.tsOffset + axis], `${entry.id} lightDirection axis ${axis}`)
          .toBe(rust[light.rustRow * 4 + axis]!);
      }
      expect(words[light.tsOffset + 3]).toBe(f32(input.view.environmentIntensity ?? 1));
      expect(rust[light.rustRow * 4 + 3]).toBe(0);
      // 交叉关系二:sunColor rgb 全等,w 双语义(ts=作者 intensity,rust=2/3 标记)。
      const sun = coreAnchor("sunColor");
      for (let axis = 0; axis < 3; axis++) {
        expect(words[sun.tsOffset + axis], `${entry.id} sunColor axis ${axis}`)
          .toBe(rust[sun.rustRow * 4 + axis]!);
      }
      expect(words[sun.tsOffset + 3]).toBe(f32(input.primaryLight.intensity));
      const hasLocals = (entry.inputs.rust.directionalLighting.localLights?.length ?? 0) > 0;
      expect(rust[sun.rustRow * 4 + 3], `${entry.id} rust authored-light marker`).toBe(hasLocals ? 3 : 2);
      // 补充观测关系:exposure(ts word 88 == rust row 14 word 0)。
      expect(words[88], `${entry.id} exposure`).toBe(rust[14 * 4]!);
      expect(words[88]).toBe(f32(entry.inputs.rust.directionalLighting.exposure));
    });
  }
});
