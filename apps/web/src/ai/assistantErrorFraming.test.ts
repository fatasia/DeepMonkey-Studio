import { ServerRequestError } from "@bim-studio/server-sdk";
import { describe, expect, it } from "vitest";
import { assistantErrorMessage, classifyAssistantError } from "./assistantErrorFraming";

const zh = (reason: unknown) => assistantErrorMessage(reason, "zh-CN");
const en = (reason: unknown) => assistantErrorMessage(reason, "en-US");

describe("K15/K16 chat 错误分型", () => {
  it("ServerRequestError 按 status 分型:401/403→auth,429→rate-limit,5xx→server,4xx→invalid", () => {
    expect(classifyAssistantError(new ServerRequestError("/x", 401, "unauthorized"))).toBe("auth");
    expect(classifyAssistantError(new ServerRequestError("/x", 403, "forbidden"))).toBe("auth");
    expect(classifyAssistantError(new ServerRequestError("/x", 429, "too many"))).toBe("rate-limit");
    expect(classifyAssistantError(new ServerRequestError("/x", 502, "bad gateway"))).toBe("server");
    expect(classifyAssistantError(new ServerRequestError("/x", 422, "invalid"))).toBe("invalid");
  });

  it("网络层失败(TypeError/浏览器原文)分型 network 并给本地化恢复动作,不透传英文原文", () => {
    expect(classifyAssistantError(new TypeError("Failed to fetch"))).toBe("network");
    expect(zh(new TypeError("Failed to fetch"))).toContain("无法连接 AI 服务");
    expect(zh(new TypeError("Failed to fetch"))).toContain("重试");
    expect(en(new TypeError("Failed to fetch"))).toContain("Cannot reach the AI service");
  });

  it("K9 超时文案已本地化带恢复动作,分型 timeout 且原样透传", () => {
    const timeout = new Error("AI 响应超时（30 秒无数据）。请重试，或检查网络与服务状态。");
    expect(classifyAssistantError(timeout)).toBe("timeout");
    expect(zh(timeout)).toBe(timeout.message);
  });

  it("额度/策略/无效按文案关键词分型,双语输出", () => {
    expect(classifyAssistantError(new Error("上游返回:额度不足"))).toBe("quota");
    expect(classifyAssistantError(new Error("content policy violation"))).toBe("policy");
    expect(zh(new Error("上游返回:额度不足"))).toContain("额度不足");
    expect(zh(new Error("content policy violation"))).toContain("内容策略");
    expect(en(new Error("content policy violation"))).toContain("content policy");
  });

  it("未知错误保留细节原文;空细节给兜底动作文案", () => {
    const mystery = new Error("weird upstream crash x91");
    expect(classifyAssistantError(mystery)).toBe("unknown");
    expect(zh(mystery)).toBe("weird upstream crash x91");
    expect(zh("")).toContain("重试");
  });
});
