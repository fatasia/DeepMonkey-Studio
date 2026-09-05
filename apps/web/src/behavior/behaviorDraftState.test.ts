import { describe, expect, it } from "vitest";
import type { ScriptModule } from "@bim-studio/contracts";
import { reconcileBehaviorDraft } from "./behaviorDraftState";

const script: ScriptModule = { id: "a", name: "脚本", code: "initial", enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.read"] };
describe("behavior draft reconciliation", () => {
  it("retains edits that arrived while a save was pending", () => {
    const draft = { ...script, code: "newer input" };
    expect(reconcileBehaviorDraft(draft, script, { ...script, code: "saved echo" })).toBe(draft);
  });
  it("accepts external updates when the local draft has not changed", () => {
    const incoming = { ...script, target: { kind: "component" as const, id: "pump" } };
    expect(reconcileBehaviorDraft({ ...script }, script, incoming)).toEqual(incoming);
    expect(reconcileBehaviorDraft(script, script, incoming)).not.toBe(incoming);
  });
  it("does not leak one file's code into the next file", () => {
    const incoming = { ...script, id: "b", code: "file b" };
    expect(reconcileBehaviorDraft({ ...script, code: "dirty a" }, script, incoming)).toEqual(incoming);
  });
  it("handles removal and an empty workspace", () => {
    expect(reconcileBehaviorDraft(script, script, undefined)).toBeUndefined();
    expect(reconcileBehaviorDraft(undefined, undefined, script)).toEqual(script);
  });
});
