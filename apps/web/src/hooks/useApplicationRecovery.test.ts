import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot, type ScriptModule } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-dashboard.json";
import { ApplicationSession } from "../studio/applicationSession";
import { applicationRecoveryKey, readApplicationRecovery, writeApplicationRecovery } from "../studio/applicationRecovery";
import { useApplicationRecovery } from "./useApplicationRecovery";

const harness = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], effects: [] as Array<() => void>, cleanups: [] as Array<() => void>, disk: new Map<string, unknown>(), failDelete: false }));
vi.mock("react", () => ({
  useRef: (initial: unknown) => { const index = harness.cursor++; return harness.cells[index] ??= { current: initial }; },
  useState: (initial: unknown) => { const index = harness.cursor++; if (!(index in harness.cells)) harness.cells[index] = initial;
    return [harness.cells[index], (value: unknown) => { harness.cells[index] = value; }]; },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const index = harness.cursor++; const prior = harness.cells[index] as unknown[] | undefined;
    if (!prior || prior.some((value, slot) => value !== deps[slot])) {
      harness.cells[index] = deps;
      harness.effects.push(() => { harness.cleanups[index]?.(); const cleanup = effect(); if (cleanup) harness.cleanups[index] = cleanup; });
    }
  },
}));
vi.mock("../studio/recoveryDatabase", () => ({
  readRecoveryRecord: async (key: string) => structuredClone(harness.disk.get(key)),
  writeRecoveryRecord: async (value: { key: string }) => { harness.disk.set(value.key, structuredClone(value)); },
  removeRecoveryRecord: async (key: string) => { if (harness.failDelete) throw new Error("disk failure"); harness.disk.delete(key); },
}));
beforeEach(() => { vi.useFakeTimers(); harness.cursor = 0; harness.cells = []; harness.effects = []; harness.cleanups = []; harness.disk.clear(); harness.failDelete = false; vi.stubGlobal("window", new EventTarget()); });
afterEach(() => { harness.cleanups.forEach(cleanup => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  const session = new ApplicationSession(); session.openDocument(migrateSceneSnapshotV1(fixture as unknown as SceneSnapshot));
  const state = { applicationSessionRef: { current: session }, activeApplication: session.getDocument(), setAutoSaveEnabled: vi.fn(), setMessage: vi.fn(), showError: vi.fn() };
  const render = () => {
    state.activeApplication = session.getDocument(); harness.cursor = 0;
    const result = useApplicationRecovery(state as unknown as Parameters<typeof useApplicationRecovery>[0]);
    harness.effects.splice(0).forEach(effect => effect()); return result;
  };
  return { session, state, render };
}

describe("application recovery lifecycle", () => {
  it("flushes edits on fast navigation without saving them under the next application's identity", async () => {
    const view = setup(); view.render(); await vi.advanceTimersByTimeAsync(1);
    const original = view.session.getDocument()!;
    view.session.store.dispatch({ id: "rename", type: "application.rename", label: "改名", payload: { name: "快速切换前的修改" } });
    const next = structuredClone(original); next.metadata.id = "next-application";
    view.session.openDocument(next); view.render(); await vi.advanceTimersByTimeAsync(1);
    expect((await readApplicationRecovery(original))?.document.metadata.name).toBe("快速切换前的修改");
    expect(harness.disk.has(applicationRecoveryKey(next))).toBe(false);
  });

  it("captures pending scripts on pagehide before debounce and clears only after a matching explicit save", async () => {
    const view = setup(); let actions = view.render(); await vi.advanceTimersByTimeAsync(1);
    const script: ScriptModule = { id: "new-script", name: "脚本", enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code: "const edited = true", lifecycle: [], capabilities: [], permissions: [] };
    actions.captureScriptDraft(script); window.dispatchEvent(new Event("pagehide")); await vi.advanceTimersByTimeAsync(1);
    const server = view.session.getDocument()!;
    expect((await readApplicationRecovery(server))?.document.scripts[0]?.code).toBe(script.code);
    actions.captureScriptDraft(undefined);
    const saved = structuredClone(server); saved.scripts.push(script); saved.metadata.revision++;
    view.session.openDocument(saved); actions = view.render(); await vi.advanceTimersByTimeAsync(1);
    expect(await readApplicationRecovery(saved)).toBeUndefined();
  });

  it("retains a failed restore or failed discard for retry and keeps the restored copy through refresh", async () => {
    const view = setup(); const server = view.session.getDocument()!; const local = structuredClone(server); local.pages[0]!.name = "恢复内容";
    await writeApplicationRecovery(local); view.render(); await vi.advanceTimersByTimeAsync(1);
    let actions = view.render(); expect(actions.draft).toBeDefined();
    const open = vi.spyOn(view.session, "openDocument"); open.mockImplementationOnce(() => { throw new Error("apply failed"); });
    await actions.restore(); actions = view.render(); expect(actions.draft).toBeDefined(); expect(view.state.showError).toHaveBeenCalled();
    harness.failDelete = true; await actions.discard(); actions = view.render(); expect(actions.draft).toBeDefined();
    harness.failDelete = false; await actions.restore(); actions = view.render();
    expect(actions.draft).toBeUndefined(); expect(view.session.store.getState().dirty).toBe(true);
    expect((await readApplicationRecovery(server))?.document.pages[0]?.name).toBe("恢复内容");
    expect(view.state.setAutoSaveEnabled).toHaveBeenCalledWith(false);
  });
});
