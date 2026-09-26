import { describe, expect, it } from "vitest";
import {
  assertOpcUaLiveBindings,
  assertOpcUaLiveEndpoint,
  isFullOpcUaNodeId,
  normalizeOpcUaLiveValue,
  resolveOpcUaNodeId,
} from "./opcUaLive.js";

describe("OPC UA Live 端点合同校验", () => {
  it("合法端点(含 identity)通过校验", () => {
    assertOpcUaLiveEndpoint({
      endpointUrl: "opc.tcp://127.0.0.1:4840",
      securityMode: "None",
      identity: { user: "operator", passwordRef: "env:OPCUA_PASSWORD" },
      namespace: 3,
    });
  });

  it("endpointUrl 必须 opc.tcp:// 开头;securityMode/namespace/identity 逐项拦截", () => {
    const base = { endpointUrl: "opc.tcp://plc:4840", securityMode: "None", namespace: 3 };
    expect(() => assertOpcUaLiveEndpoint({ ...base, endpointUrl: "http://plc:4840" })).toThrow("opc.tcp://");
    expect(() => assertOpcUaLiveEndpoint({ ...base, securityMode: "Encrypt" })).toThrow("None/Sign/SignAndEncrypt");
    expect(() => assertOpcUaLiveEndpoint({ ...base, namespace: -1 })).toThrow("非负整数");
    expect(() => assertOpcUaLiveEndpoint({ ...base, namespace: 1.5 })).toThrow("非负整数");
    expect(() => assertOpcUaLiveEndpoint({ ...base, identity: { user: "op" } })).toThrow("passwordRef");
    expect(() => assertOpcUaLiveEndpoint({ ...base, identity: { user: "", passwordRef: "x" } })).toThrow("user");
  });
});

describe("OPC UA Live 绑定与 NodeId 规则", () => {
  it("完整形式与相对 id 分别直通/展开;纯数字按数值 id", () => {
    expect(isFullOpcUaNodeId("ns=2;s=Channel1.Tag1")).toBe(true);
    expect(isFullOpcUaNodeId("ns=2;i=1001")).toBe(true);
    expect(isFullOpcUaNodeId("Tag1")).toBe(false);
    expect(resolveOpcUaNodeId("ns=2;s=Channel1.Tag1", 3)).toBe("ns=2;s=Channel1.Tag1");
    expect(resolveOpcUaNodeId("Tag1", 3)).toBe("ns=3;s=Tag1");
    expect(resolveOpcUaNodeId("1001", 3)).toBe("ns=3;i=1001");
  });

  it("形似完整但非法的 NodeId 显式报错;绑定重复 signal/空值被拦截", () => {
    expect(() => resolveOpcUaNodeId("ns=x;s=Tag1", 3)).toThrow("NodeId");
    expect(() => resolveOpcUaNodeId("ns=2", 3)).toThrow("NodeId");
    expect(() => resolveOpcUaNodeId("a;b", 3)).toThrow("NodeId");
    expect(() => assertOpcUaLiveBindings([])).toThrow("非空数组");
    expect(() => assertOpcUaLiveBindings([{ signal: "motor", nodeId: "Tag1" }, { signal: "motor", nodeId: "Tag2" }])).toThrow("重复");
    expect(() => assertOpcUaLiveBindings([{ signal: "motor", nodeId: "" }])).toThrow("nodeId 不能为空");
    expect(() => assertOpcUaLiveBindings([{ signal: "motor", nodeId: "ns=2;Tag1" }])).toThrow("NodeId 规范");
    assertOpcUaLiveBindings([{ signal: "motor", nodeId: "ns=2;s=Tag1" }, { signal: "startCmd", nodeId: "1002" }]);
  });
});

describe("OPC UA Variant 标量归一化", () => {
  it("布尔/有限数字/字符串/安全 BigInt 直通;NaN、对象、null 显式不支持", () => {
    expect(normalizeOpcUaLiveValue(true)).toBe(true);
    expect(normalizeOpcUaLiveValue(42.5)).toBe(42.5);
    expect(normalizeOpcUaLiveValue("idle")).toBe("idle");
    expect(normalizeOpcUaLiveValue(9007199254740991n)).toBe(9007199254740991);
    expect(normalizeOpcUaLiveValue(10000000000000000001n)).toBe("10000000000000000001");
    expect(normalizeOpcUaLiveValue(Number.NaN)).toBeUndefined();
    expect(normalizeOpcUaLiveValue({ ExtensionObject: true })).toBeUndefined();
    expect(normalizeOpcUaLiveValue(null)).toBeUndefined();
    expect(normalizeOpcUaLiveValue(undefined)).toBeUndefined();
  });
});
