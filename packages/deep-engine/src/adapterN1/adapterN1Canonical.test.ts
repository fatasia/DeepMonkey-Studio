/**
 * canonical JSON 与 SVG 子集解析的合同级单元测试:
 * 摘要机制与 serde_json/ryu 语义对齐,SVG 支持矩阵之外的输入全部拒绝。
 */

import { describe, expect, it } from "vitest";

import { canonicalJsonText, parseJsonBytes } from "./canonicalJson.js";
import { parseSvgPathSubset } from "./svgPathSubset.js";

function canonicalOf(text: string): string {
  return canonicalJsonText(parseJsonBytes(new TextEncoder().encode(text)));
}

describe("canonical JSON number semantics mirror serde_json", () => {
  it("integer and float tokens canonicalize differently and stay exact", () => {
    expect(canonicalOf("1")).toBe("1");
    expect(canonicalOf("1.0")).toBe("1.0");
    expect(canonicalOf("1e2")).toBe("100.0");
    expect(canonicalOf("0.1")).toBe("0.1");
    expect(canonicalOf("-0")).toBe("0");
    expect(canonicalOf("-0.0")).toBe("-0.0");
    expect(canonicalOf("9007199254740993")).toBe("9007199254740993");
  });

  it("ryu-pretty layout windows: plain decimal in kk ∈ (-5, 16], scientific outside", () => {
    expect(canonicalOf("0.0001")).toBe("0.0001");
    expect(canonicalOf("0.00001")).toBe("0.00001");
    expect(canonicalOf("1e-6")).toBe("1e-6");
    expect(canonicalOf("1e-7")).toBe("1e-7");
    expect(canonicalOf("1000000000000000.0")).toBe("1000000000000000.0");
    expect(canonicalOf("1e16")).toBe("1e16");
    expect(canonicalOf("1e21")).toBe("1e21");
    expect(canonicalOf("1.234e33")).toBe("1.234e33");
    expect(canonicalOf("2.5e-8")).toBe("2.5e-8");
  });

  it("keys sort by UTF-8 byte order (code points), formatting is compact", () => {
    expect(canonicalOf('{"b":1,"a":{"d":2,"c":[true,null,"x"]}}')).toBe('{"a":{"c":[true,null,"x"],"d":2},"b":1}');
    expect(canonicalOf("  {  \"a\" : 1 }  ")).toBe('{"a":1}');
    expect(canonicalOf('{"k":"\\u00e9\\n"}')).toBe('{"k":"é\\n"}');
  });
});

describe("JSON scanner rejects what serde_json rejects", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["{oops", ""],
    ['{"a":1}{"b":2}', "trailing"],
    ['{"a":01}', "invalid number"],
    ['{"a":1.}', "invalid number"],
    ['{"a":+1}', "expected value"],
    ['{"a":"\\ud8"}', "invalid \\u escape"],
    ['{"a":"\\ud800"}', "lone leading surrogate"],
    ['{"a":"line\nbreak"}', "control character"],
    ['{"a":1,}', "key must be a string"],
    ["1 1", "trailing"],
  ];

  it.each(rejected)("rejects %s", (input) => {
    expect(() => canonicalOf(input as string)).toThrow();
  });

  it("rejects nesting at the 128-container recursion limit (serde_json semantics)", () => {
    const deep = "[".repeat(128) + "1" + "]".repeat(128);
    expect(() => canonicalOf(deep)).toThrow("recursion limit exceeded");
    expect(() => canonicalOf("[".repeat(127) + "1" + "]".repeat(127))).not.toThrow();
  });

  it("accepts valid surrogate pairs as astral characters", () => {
    expect(canonicalOf('{"a":"\\ud83d\\ude00"}')).toBe('{"a":"😀"}');
  });
});

describe("SVG path subset support matrix (fail-closed)", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["M 0 0 C 1 1 2 2 3 3", "unsupported svg path command 'C'"],
    ["M 0 0 Q 1 1 2 2", "unsupported svg path command 'Q'"],
    ["M 0 0 A 1 1 0 0 1 2 2", "unsupported svg path command 'A'"],
    ["M 0 0 X 1", "unsupported svg path command 'X'"],
    ["M 0 0 1 1", "implicit coordinate repetition"],
    ["L 1 1", "subpath must start"],
    ["M 0 0 # 1", "unexpected character '#'"],
    ["M 1e400 0", "not finite"],
    ["", "no drawing commands"],
    ["1 1", "command letters"],
  ];

  it.each(rejected)("rejects '%s' with '%s'", (data, reason) => {
    expect(() => parseSvgPathSubset(data)).toThrow(reason);
  });

  it.each(["M 0 0", "m 2 2 l 1 1 h 1 v 1 z", "M0,0L1,1z"])("accepts '%s'", (data) => {
    expect(() => parseSvgPathSubset(data)).not.toThrow();
  });

  it("normalizes relative commands to absolute verbs and Z returns to the subpath start", () => {
    expect(parseSvgPathSubset("m 2 2 l 1 1 h 1 v 1 z")).toEqual([
      { op: "move", x: 2, y: 2 }, { op: "line", x: 3, y: 3 }, { op: "line", x: 4, y: 3 },
      { op: "line", x: 4, y: 4 }, { op: "close" },
    ]);
    expect(parseSvgPathSubset("M 0 0 L 2 0 Z M 5 5 L 6 5")).toEqual([
      { op: "move", x: 0, y: 0 }, { op: "line", x: 2, y: 0 }, { op: "close" },
      { op: "move", x: 5, y: 5 }, { op: "line", x: 6, y: 5 },
    ]);
  });
});
