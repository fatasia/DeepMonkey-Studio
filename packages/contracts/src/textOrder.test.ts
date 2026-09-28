import { describe, expect, it } from "vitest";
import { compareText } from "./textOrder.js";

describe("compareText(码元序,localeCompare 同族清剿规范实现)", () => {
  it("与 JS 规范 `<`/`>` 字符串比较逐值一致(含 ASCII 全域采样)", () => {
    const alphabet = [
      ...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
      "ABC", "aBc", "abc", "Abc", "0", "1", "10", "2", "9", "00",
      "sha-256abcdef", "node_001", "res://a/b", "2026-09-28T00:00:00Z",
    ];
    for (const left of alphabet) {
      for (const right of alphabet) {
        const expected = left < right ? -1 : left > right ? 1 : 0;
        expect(compareText(left, right)).toBe(expected);
      }
    }
  });

  it("对常见 ASCII 数据(id/哈希/ISO 时间戳/路径)排序稳定", () => {
    const values = [
      "conv_9", "conv_10", "node-a2", "node-a10", "b3f2c1", "a1",
      "2026-01-02", "2025-12-31", "res/a", "res/a/b", "res//",
    ];
    const sorted = [...values].sort(compareText);
    expect(sorted).toEqual([...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  });

  it("非 ASCII 输入只依赖码元,不读 ICU(与 locale 无关的确定性)", () => {
    // UTF-16 码元序:U+4E00 ("一") < U+8A9E ("語");ASCII 恒先于 CJK。
    expect(compareText("中文", "漢字")).toBe(-1);
    expect(compareText("asset-中文-2", "asset-中文-10")).toBe(1);
    expect(compareText("café", "cafe")).toBe(1); // U+00E9 > U+0065
    expect(compareText("", "a")).toBe(-1);
    expect(compareText("a", "a")).toBe(0);
  });

  it("按 UTF-16 码元(非码点)比较:代理对首单元小于 U+FFFF 之后仍按单元序", () => {
    // U+FFFF vs U+10000("\u{10000}" 的首码元为 D800):码元序下 "\uFFFF" 更大。
    expect(compareText("\uFFFF", "\u{10000}")).toBe(1);
    expect(compareText("\u{10000}", "\uFFFF")).toBe(-1);
    expect(compareText("\u{10000}", "\u{10000}")).toBe(0);
  });

  it("满足全序三律(自反/反对称/传递抽样)", () => {
    const values = ["", "a", "A", "b", "ab", "中", "文", "\u{10000}", "\uFFFF", "0", "10"];
    for (const value of values) {
      expect(compareText(value, value)).toBe(0);
      for (const other of values) {
        const forward = Math.sign(compareText(value, other));
        const backward = Math.sign(compareText(other, value));
        expect(forward).toBe(backward === 0 ? 0 : -backward);
      }
    }
    for (const a of values) {
      for (const b of values) {
        for (const c of values) {
          if (compareText(a, b) < 0 && compareText(b, c) < 0) {
            expect(compareText(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });
});
