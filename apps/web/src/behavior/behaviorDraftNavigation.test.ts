import type { ScriptModule } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { flushPendingBehaviorDraft } from "./behaviorDraftNavigation";

const draft = (name: string): ScriptModule => ({
  id: "script:one",
  name,
  enabled: true,
  apiVersion: "1.0",
  entrypoint: "behavior",
  runtime: "worker-sandbox",
  code: "function onStart() {}",
  lifecycle: ["onStart"],
  capabilities: ["studio.runtime"],
  permissions: ["scene.read"],
  target: { kind: "scene" },
});

describe("flushPendingBehaviorDraft", () => {
  it("retains the draft when the target becomes locked before navigation", () => {
    const value = draft("Locked target");
    const pending = { current: value as ScriptModule | undefined };
    expect(flushPendingBehaviorDraft(pending, () => false)).toBe("write-rejected");
    expect(pending.current).toBe(value);
  });
  it("commits a valid draft once and clears the navigation guard", () => {
    const pending = { current: draft("设备告警") as ScriptModule | undefined };
    const upsert = vi.fn();

    expect(flushPendingBehaviorDraft(pending, upsert)).toBe("saved");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ name: "设备告警" }));
    expect(pending.current).toBeUndefined();
  });

  it("keeps an unnamed draft so workspace navigation cannot lose it", () => {
    const unnamed = draft("   ");
    const pending = { current: unnamed as ScriptModule | undefined };
    const upsert = vi.fn();

    expect(flushPendingBehaviorDraft(pending, upsert)).toBe("name-required");
    expect(upsert).not.toHaveBeenCalled();
    expect(pending.current).toBe(unnamed);
  });
});
