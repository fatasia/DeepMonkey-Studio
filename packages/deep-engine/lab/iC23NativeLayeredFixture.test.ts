/** I-C23 Native 刀 · 双端对拍 fixture 漂移门。
 * fixture(packages/deep-engine/fixtures/i-c23-native-layered-block-v1.json)
 * 是 scripts/i-c23-native-layered-fixture.mjs 用 TS 单源真函数生成的生成物;
 * 本门保证仓内 JSON 与重算结果逐位一致 —— TS 侧或 Rust 侧任一端漂移都在
 * 此处失败,而不是在 GPU 白炉轮上炸。 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildIC23NativeLayeredFixture } from "./iC23NativeLayeredFixture.js";

const fixturePath = join(import.meta.dirname ?? ".", "../fixtures/i-c23-native-layered-block-v1.json");

it("keeps the checked-in dual-end fixture bit-identical to the TS authority", () => {
  const expected = buildIC23NativeLayeredFixture();
  const stored = JSON.parse(readFileSync(fixturePath, "utf8"));
  expect(stored.abi).toBe(expected.abi);
  expect(stored.blockBytes).toBe(expected.blockBytes);
  expect(stored.block).toEqual(expected.block);
  expect(stored.blendCases).toEqual(expected.blendCases);
  expect(stored.furnace).toEqual(expected.furnace);
});

it("packs exactly 76 floats whose header words encode count and ABI version", () => {
  const { block } = buildIC23NativeLayeredFixture();
  expect(block).toHaveLength(76);
  const word = (index: number): number => new Uint32Array(new Float32Array([block[index]!]).buffer)[0]!;
  expect(word(0)).toBe(2); // activeCount
  expect(word(1)).toBe(1); // LAYERED_SURFACE_ABI_VERSION
  expect(word(2)).toBe(0);
});
