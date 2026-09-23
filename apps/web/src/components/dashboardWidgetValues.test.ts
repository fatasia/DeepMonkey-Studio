import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dashboardDisplayNumber, dashboardDisplayText } from "./dashboardWidgetValues";

describe("dashboardDisplayNumber", () => {
  it("清除 IEEE754 二进制噪声", () => {
    // 77.46 在二进制浮点里经 clamp/四则后常见噪声尾巴
    assert.equal(dashboardDisplayNumber(77.46000000000001), 77.46);
    assert.equal(dashboardDisplayNumber(0.30000000000000004), 0.3);
    assert.equal(dashboardDisplayNumber(19.999999999999996), 20);
  });

  it("不改变合法精度与整数", () => {
    assert.equal(dashboardDisplayNumber(78.32), 78.32);
    assert.equal(dashboardDisplayNumber(3.14159265358979), 3.14159265359);
    assert.equal(dashboardDisplayNumber(100), 100);
    assert.equal(dashboardDisplayNumber(0), 0);
    assert.equal(dashboardDisplayNumber(-7.5), -7.5);
  });

  it("非有限值原样返回由调用方兜底", () => {
    assert.equal(dashboardDisplayNumber(Number.NaN), Number.NaN);
    assert.equal(dashboardDisplayNumber(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  });
});

describe("dashboardDisplayText", () => {
  it("数字走噪声清理", () => {
    assert.equal(dashboardDisplayText(77.46000000000001), "77.46");
    assert.equal(dashboardDisplayText(42), "42");
  });

  it("空值占位与对象序列化", () => {
    assert.equal(dashboardDisplayText(undefined), "—");
    assert.equal(dashboardDisplayText(null), "—");
    assert.equal(dashboardDisplayText(""), "—");
    assert.equal(dashboardDisplayText(Number.NaN), "—");
    assert.equal(dashboardDisplayText({ a: 1 }), '{"a":1}');
  });

  it("字符串与布尔原样", () => {
    assert.equal(dashboardDisplayText("正常"), "正常");
    assert.equal(dashboardDisplayText(true), "true");
  });
});
