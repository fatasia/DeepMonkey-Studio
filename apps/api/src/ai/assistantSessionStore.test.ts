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

it("labels every conflict with a machine-readable code so clients can tell cross-tab clashes apart", async () => {
  const { store } = await fixture();
  await store.create("u", "p", "s", "会话");
  const turn = { sequence: 1, question: "检查", answer: "局部", mode: "scene" as const, status: "streaming" as const };
  await store.putMessage("u", "p", "s", "m", turn);
  // previous 仍为 streaming：改问题/范围命中内容冲突。
  await expect(store.putMessage("u", "p", "s", "m", { ...turn, sequence: 3, question: "换问题" })).rejects.toMatchObject({ status: 409, code: "message-content-conflict" });
  await store.putMessage("u", "p", "s", "m", { ...turn, sequence: 2, answer: "更多", status: "stopped" });
  // previous 已终态：序号回退/继续推进均命中版本冲突。
  await expect(store.putMessage("u", "p", "s", "m", turn)).rejects.toMatchObject({ status: 409, code: "message-version-conflict" });
  await expect(store.putMessage("u", "p", "s", "m", { ...turn, sequence: 3, status: "streaming" })).rejects.toMatchObject({ status: 409, code: "message-version-conflict" });
  await expect(store.create("u", "p", "s", "另一个标题")).rejects.toMatchObject({ status: 409, code: "session-title-conflict" });
  try { store.messages("u", "p", "missing", undefined, 20); expect.unreachable("读取不存在的会话必须拒绝"); }
  catch (error) { expect(error).toMatchObject({ status: 404, code: "session-not-found" }); }
});

it("rejects conditional writes whose If-Match no longer matches the server version (K12 cross-tab guard)", async () => {
  const { store } = await fixture();
  await store.create("u", "p", "s", "会话");
  const turn = { sequence: 1, question: "检查", answer: "局部", mode: "scene" as const, status: "streaming" as const };
  const first = await store.putMessage("u", "p", "s", "m", turn);
  expect(first.sequence).toBe(1);
  // 同一版本重放（内容相同幂等）放行；版本推进需携带服务端当前版本。
  expect(await store.putMessage("u", "p", "s", "m", turn, '"v1"')).toMatchObject({ sequence: 1 });
  const second = await store.putMessage("u", "p", "s", "m", { ...turn, answer: "推进", sequence: 2 }, '"v1"');
  expect(second.sequence).toBe(2);
  // 过期版本（另一窗口已推进到 2）→ 语义化 409，而非静默覆盖。
  await expect(store.putMessage("u", "p", "s", "m", { ...turn, answer: "覆盖", sequence: 3 }, '"v1"'))
    .rejects.toMatchObject({ status: 409, code: "message-version-conflict" });
  // 弱 ETag 前缀被正确归一：过期版本仍拒绝，当前版本放行；无法解析的值按不匹配拒绝。
  await expect(store.putMessage("u", "p", "s", "m", { ...turn, answer: "再推进", sequence: 3 }, 'W/"v1"')).rejects.toMatchObject({ status: 409, code: "message-version-conflict" });
  await expect(store.putMessage("u", "p", "s", "m", { ...turn, answer: "再推进", sequence: 3 }, "garbage")).rejects.toMatchObject({ status: 409, code: "message-version-conflict" });
  await expect(store.putMessage("u", "p", "s", "m", { ...turn, answer: "再推进", sequence: 3 }, 'W/"v2"')).resolves.toMatchObject({ answer: "再推进" });
  // 新消息（尚无 previous）不受 If-Match 影响，条件只约束已有轮次的覆盖。
  await expect(store.putMessage("u", "p", "s", "m2", turn, '"v999"')).resolves.toMatchObject({ id: "m2" });
});

it("validates If-Match on the idempotent create path so a stale tab cannot pin an old session state", async () => {
  const { store } = await fixture();
  const created = await store.create("u", "p", "s", "会话");
  expect(await store.create("u", "p", "s", "会话", '"v0"')).toMatchObject({ id: "s" });
  const turn = { sequence: 1, question: "检查", answer: "已读取", mode: "scene" as const, status: "completed" as const };
  await store.putMessage("u", "p", "s", "m", turn);
  await expect(store.create("u", "p", "s", "会话", '"v0"')).rejects.toMatchObject({ status: 409, code: "session-version-conflict" });
  expect(await store.create("u", "p", "s", "会话", '"v1"')).toMatchObject({ id: "s" });
});
