import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AssistantSessionStore } from "./assistantSessionStore.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-session-store-")); directories.push(directory);
  const store = new AssistantSessionStore(directory); await store.init(); return { directory, store };
}
it("enforces per-owner/project session and per-session turn counts without pruning history", async () => {
  const { store } = await fixture();
  for (let index = 0; index < 50; index++) await store.create("u", "p", `s${index}`, "会话");
  await expect(store.create("u", "p", "overflow", "会话")).rejects.toMatchObject({ status: 429 });
  expect(store.list("u", "p", undefined, 50).items).toHaveLength(50);
  const turn = { sequence: 1, question: "检查", answer: "结果", mode: "scene" as const, status: "completed" as const };
  for (let index = 0; index < 100; index++) await store.putMessage("u", "p", "s0", `m${index}`, turn);
  await expect(store.putMessage("u", "p", "s0", "overflow", turn)).rejects.toMatchObject({ status: 429 });
  expect(store.messages("u", "p", "s0", undefined, 50).session.messageCount).toBe(100);
});

it("exposes only committed turns when atomic replacement fails, then permits retry", async () => {
  const { directory, store } = await fixture();
  await store.create("u", "p", "s", "会话");
  const file = path.join(directory, "assistant-sessions.json");
  await rename(file, `${file}.saved`); await mkdir(file);
  const turn = { sequence: 1, question: "检查", answer: "局部", mode: "scene" as const, status: "stopped" as const };
  await expect(store.putMessage("u", "p", "s", "m", turn)).rejects.toThrow();
  expect(store.messages("u", "p", "s", undefined, 20).messages).toEqual([]);
  await rm(file, { recursive: true }); await rename(`${file}.saved`, file);
  const committed = await store.putMessage("u", "p", "s", "m", turn);
  const restored = new AssistantSessionStore(directory); await restored.init();
  expect(restored.messages("u", "p", "s", undefined, 20).messages).toEqual([committed]);
});
