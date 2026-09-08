import { describe, expect, it } from "vitest";
import { ScriptAssistantSession } from "./scriptAssistantSession";

describe("ScriptAssistantSession", () => {
  it("deduplicates requests before React can disable a button", () => {
    const session = new ScriptAssistantSession();
    const first = session.begin("project/scene/script/generate")!;
    expect(session.begin(first.owner)).toBeUndefined();
    expect(session.isCurrent(first, first.owner)).toBe(true);
    expect(session.finish(first)).toBe(true);
    expect(session.begin(first.owner)).toBeDefined();
  });

  it.each(["new-project", "new-scene", "new-script", "new-code", "new-target", "new-mode"])("rejects a stale response after %s even before effect cleanup", owner => {
    const session = new ScriptAssistantSession();
    const request = session.begin("initial-context")!;
    expect(session.isCurrent(request, owner)).toBe(false);
    session.cancel();
    expect(request.controller.signal.aborted).toBe(true);
    expect(session.finish(request)).toBe(false);
  });

  it("propagates cancellation and prevents old finally from releasing a newer request", async () => {
    const session = new ScriptAssistantSession();
    const old = session.begin("same-context")!;
    const cancelled = new Promise(resolve => old.controller.signal.addEventListener("abort", () => resolve("aborted")));
    session.cancel();
    expect(await cancelled).toBe("aborted");
    const current = session.begin("same-context")!;
    expect(session.isCurrent(old, old.owner)).toBe(false);
    expect(session.finish(old)).toBe(false);
    expect(session.isCurrent(current, current.owner)).toBe(true);
    session.cancel();
    expect(current.controller.signal.aborted).toBe(true);
  });
});
