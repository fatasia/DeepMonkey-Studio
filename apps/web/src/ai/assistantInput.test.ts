import { describe, expect, it } from "vitest";
import { isAssistantScrollPinned, shouldSendAssistantInput } from "./assistantInput";

describe("assistant input", () => {
  it("sends plain Enter, keeps Shift+Enter as a newline and ignores other keys", () => {
    expect(shouldSendAssistantInput({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSendAssistantInput({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSendAssistantInput({ key: "a", shiftKey: false })).toBe(false);
  });
  it("preserves CJK candidate confirmation across browser composition event variants", () => {
    expect(shouldSendAssistantInput({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSendAssistantInput({ key: "Enter", shiftKey: false }, true)).toBe(false);
    expect(shouldSendAssistantInput({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
  });
  it("follows output near the bottom without pulling a reader out of earlier messages", () => {
    expect(isAssistantScrollPinned({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(true);
    expect(isAssistantScrollPinned({ scrollHeight: 1000, clientHeight: 400, scrollTop: 552 })).toBe(true);
    expect(isAssistantScrollPinned({ scrollHeight: 1000, clientHeight: 400, scrollTop: 551 })).toBe(false);
    expect(isAssistantScrollPinned({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 })).toBe(true);
  });
});
