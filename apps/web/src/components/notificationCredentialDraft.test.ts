import { describe, expect, it } from "vitest";
import { buildCredential, credentialRequired, type NotificationCredentialDrafts } from "./notificationCredentialDraft";

const empty: NotificationCredentialDrafts = {
  smtp: { host: "", port: "587", from: "", username: "", password: "", secure: false },
  lark: { appId: "", appSecret: "" },
  wecom: { corpId: "", corpSecret: "", agentId: "" },
  dingtalk: { appKey: "", appSecret: "", agentId: "" },
  webhookSecret: "",
};

describe("notification credentials", () => {
  it("builds structured SMTP and enterprise credentials without a generic secret", () => {
    expect(buildCredential("smtp", false, {
      ...empty,
      smtp: { host: "smtp.example.test", port: "465", from: "ops@example.test", username: "ops", password: "secret", secure: true },
    })).toEqual({ kind: "smtp", host: "smtp.example.test", port: 465, from: "ops@example.test", username: "ops", password: "secret", secure: true });
    expect(buildCredential("wecom", true, {
      ...empty,
      wecom: { corpId: "corp", corpSecret: "secret", agentId: "1001" },
    })).toEqual({ kind: "wecom", corpId: "corp", corpSecret: "secret", agentId: 1001 });
  });

  it("requires credentials for SMTP and enterprise applications but not group bots", () => {
    expect(buildCredential("dingtalk", true, empty)).toBeUndefined();
    expect(credentialRequired("smtp", undefined)).toBe(true);
    expect(credentialRequired("lark", "application")).toBe(true);
    expect(credentialRequired("lark", "bot")).toBe(false);
  });
});
