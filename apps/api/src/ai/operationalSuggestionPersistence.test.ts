import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { OperationsService } from "../operations.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-suggestion-")); directories.push(directory);
  const service = new OperationsService(directory); await service.init();
  return { service, directory };
}

describe("reviewed AI suggestions reuse operational cases", () => {
  it("deduplicates concurrent retries, restores after restart, and keeps project scope", async () => {
    const { service, directory } = await fixture();
    const draft = { title: "样例 · 能耗核对", type: "energy" as const, status: "triage" as const, externalRef: "ai-draft:energy:sample", suggestedActions: ["核对空转时段"], sourceRefs: ["synthetic-run"] };
    const results = await Promise.all([service.saveCase("p1", draft), service.saveCase("p1", draft)]);
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(service.snapshot("p1").cases).toHaveLength(1);
    const other = await service.saveCase("p2", draft);
    expect(other.id).not.toBe(results[0]!.id);
    const restored = new OperationsService(directory); await restored.init();
    expect(restored.snapshot("p1").cases).toMatchObject([{ externalRef: draft.externalRef, suggestedActions: ["核对空转时段"], status: "triage" }]);
    await restored.saveCase("p1", { id: results[0]!.id, status: "dismissed" });
    expect(restored.snapshot("p1").cases[0]).toMatchObject({ status: "dismissed", sourceRefs: ["synthetic-run"] });
    await restored.saveCase("p1", draft);
    expect(restored.snapshot("p1").cases).toHaveLength(1);
    expect(restored.snapshot("p1").cases[0]?.status).toBe("triage");
  });

  it("rejects failed disk writes without exposing an unsaved suggestion, then retries", async () => {
    const { service, directory } = await fixture();
    const draft = { title: "样例 · 视觉核对", externalRef: "ai-draft:vision:sample" };
    const stored = path.join(directory, "operations.json"), backup = `${stored}.backup`;
    await rename(stored, backup); await mkdir(stored);
    await expect(service.saveCase("p1", draft)).rejects.toThrow();
    expect(service.snapshot("p1").cases).toEqual([]);
    await rm(stored, { recursive: true }); await rename(backup, stored);
    await service.saveCase("p1", draft);
    const restored = new OperationsService(directory); await restored.init();
    expect(restored.snapshot("p1").cases).toHaveLength(1);
  });
});
