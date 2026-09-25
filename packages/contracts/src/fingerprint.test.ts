import { describe, expect, it } from "vitest";
import { canonicalJson, fingerprint64, fingerprint64Labeled, FingerprintInputError } from "./fingerprint.js";

describe("canonicalJson", () => {
  it("对象键按字典序输出,与插入顺序无关", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("嵌套结构同样键序归一", () => {
    expect(canonicalJson({ z: { y: 1, x: [3, { c: 1, b: 2 }] } }))
      .toBe('{"z":{"x":[3,{"b":2,"c":1}],"y":1}}');
  });

  it("undefined 字段被剔除,与显式缺省等价", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("-0 归一为 0", () => {
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  it("循环引用拒绝并报错", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(FingerprintInputError);
  });

  it("NaN/Infinity/Date/bigint 显式拒绝,不静默产出平台相关文本", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(FingerprintInputError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(FingerprintInputError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(FingerprintInputError);
    expect(() => canonicalJson({ a: 1n })).toThrow(FingerprintInputError);
  });
});

describe("fingerprint64", () => {
  it("同结构同指纹,键序无关", () => {
    expect(fingerprint64({ b: [1, 2, { c: "x" }], a: true }))
      .toBe(fingerprint64({ a: true, b: [1, 2, { c: "x" }] }));
  });

  it("不同输入不碰撞(抽样:字段增删/值变化/顺序敏感数组)", () => {
    const base = fingerprint64({ a: 1, b: "x" });
    expect(fingerprint64({ a: 1 })).not.toBe(base);
    expect(fingerprint64({ a: 1, b: "y" })).not.toBe(base);
    expect(fingerprint64({ a: 1, b: "x", c: null })).not.toBe(base);
    expect(fingerprint64({ b: "x", a: 1 })).toBe(base);
    expect(fingerprint64([1, 2])).not.toBe(fingerprint64([2, 1]));
  });

  it("输出 16 位小写十六进制", () => {
    expect(fingerprint64({})).toMatch(/^[0-9a-f]{16}$/);
  });

  it("空对象与空数组是不同指纹", () => {
    expect(fingerprint64({})).not.toBe(fingerprint64([]));
  });
});

describe("fingerprint64Labeled", () => {
  it("标签参与材料,同值不同标签不同指纹", () => {
    expect(fingerprint64Labeled([["a", 1]])).not.toBe(fingerprint64Labeled([["b", 1]]));
    expect(fingerprint64Labeled([["a", 1], ["b", 2]])).toBe(fingerprint64Labeled([["b", 2], ["a", 1]]));
  });
});
