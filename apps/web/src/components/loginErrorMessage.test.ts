import { describe, expect, it } from "vitest";
import { ServerRequestError } from "@bim-studio/server-sdk";
import { loginErrorMessage } from "./loginErrorMessage";

describe("login failure recovery", () => {
  it.each([500, 502, 503, 504])("explains HTTP %s without blaming credentials", (status) => {
    expect(loginErrorMessage(new ServerRequestError("Bad Gateway", status, {}), "zh-CN")).toContain("无需修改密码");
  });
  it("distinguishes credentials, rate limits and network errors", () => {
    expect(loginErrorMessage(new ServerRequestError("Unauthorized", 401, {}), "en-US")).toBe("Incorrect username or password");
    expect(loginErrorMessage(new ServerRequestError("limit", 429, {}), "zh-CN")).toContain("尝试过于频繁");
    expect(loginErrorMessage(new TypeError("Failed to fetch"), "zh-CN")).toContain("检查网络");
    expect(loginErrorMessage(new Error("账号已禁用"), "zh-CN")).toBe("账号已禁用");
  });
});
