import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot, type ScriptModule } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-dashboard.json";
import { ApplicationSession } from "./applicationSession";
import { applicationRecoveryDocument, applicationRecoveryFingerprint, applicationRecoveryKey, discardApplicationRecovery,
  readApplicationRecovery, restoredApplicationDocument, writeApplicationRecovery } from "./applicationRecovery";

const disk = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./recoveryDatabase", () => ({
  readRecoveryRecord: vi.fn(async (key: string) => structuredClone(disk.get(key))),
  writeRecoveryRecord: vi.fn(async (value: { key: string }) => { disk.set(value.key, structuredClone(value)); }),
  removeRecoveryRecord: vi.fn(async (key: string) => { disk.delete(key); }),
}));
beforeEach(() => disk.clear());
const make = () => migrateSceneSnapshotV1(fixture as unknown as SceneSnapshot);

describe("application offline recovery", () => {
  it("captures uncommitted script text with pages without mutating the active document", async () => {
    const original = make();
    const pending: ScriptModule = { id: "script-one", name: "运动", code: "export const value = 2;", enabled: true,
      apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", lifecycle: [], capabilities: [], permissions: [] };
    const captured = applicationRecoveryDocument(original, pending);
    await writeApplicationRecovery(captured);
    const loaded = await readApplicationRecovery(original);
    expect(loaded?.document.scripts[0]?.code).toBe(pending.code);
    expect(loaded?.document.pages).toEqual(original.pages);
    expect(original.scripts).toEqual([]);
    expect(loaded?.document).not.toBe(captured);
  });

  it("restores pages and name against a newer server revision, remains dirty and survives another refresh", async () => {
    const server = make(); server.metadata.revision = 12;
    const local = structuredClone(server); local.metadata.revision = 3; local.metadata.name = "离线页面";
    local.pages[0]!.name = "本地看板";
    await writeApplicationRecovery(local);
    const copy = (await readApplicationRecovery(server))!;
    const session = new ApplicationSession();
    session.openDocument(restoredApplicationDocument(copy, server)); session.acknowledgeSave(server);
    expect(session.getDocument()?.metadata).toMatchObject({ name: "离线页面", revision: 12 });
    expect(session.getDocument()?.pages[0]?.name).toBe("本地看板");
    expect(session.store.getState().dirty).toBe(true);
    expect(await readApplicationRecovery(server)).toEqual(copy);
    expect(server.pages[0]?.name).not.toBe("本地看板");
    await discardApplicationRecovery(server);
    expect(await readApplicationRecovery(server)).toBeUndefined();
  });

  it("ignores metadata-only versions and rejects a cross-project recovery record", async () => {
    const server = make(); const updated = structuredClone(server);
    updated.metadata.revision++; updated.metadata.updatedAt = "2030-01-01T00:00:00Z";
    expect(applicationRecoveryFingerprint(updated)).toBe(applicationRecoveryFingerprint(server));
    await writeApplicationRecovery(server);
    const record = (await readApplicationRecovery(server))!;
    record.document.metadata.projectId = "another-project";
    disk.set(applicationRecoveryKey(server), record);
    expect(await readApplicationRecovery(server)).toBeUndefined();
    expect(() => restoredApplicationDocument({ ...record, key: "wrong" }, server)).toThrow("不属于");
  });
});
