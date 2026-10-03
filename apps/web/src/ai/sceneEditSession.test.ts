import { describe, expect, it } from "vitest";
import type { SceneCommand } from "@bim-studio/scene-sdk";
import { SceneEditRunner, type SceneEditApplyOutcome, type SceneEditRecord, type SceneEditMode, type SceneEditPort } from "./sceneEditSession";
import { simulateSceneCommands, type SceneStateSnapshot } from "./sceneEditState";

const initial = (): SceneStateSnapshot => ({
  sceneId: "s", camera: { position: [0, 0, 8], target: [0, 0, 0] }, lighting: {}, environment: {},
  objects: [{ id: "a", name: "泵", kind: "primitive", visible: true, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: "#112233" }],
});
const move = (x: number) => ({ id: "m", type: "object.set-transform", target: { kind: "object", sceneId: "s", objectId: "a" }, position: [x, 0, 0] });
const plan = (summary: string, commands: unknown[]) => JSON.stringify({ summary, commands });
const verdict = (achieved: boolean, reason: string, correction?: unknown) => JSON.stringify({ achieved, reason, ...(correction ? { correction } : {}) });

function harness(replies: Array<string | Error>, options: { applyStatus?: SceneEditApplyOutcome["status"]; drift?: (state: SceneStateSnapshot) => void; unavailable?: string } = {}) {
  let state = initial();
  const stack: Array<{ label: string; before: SceneStateSnapshot }> = [];
  const asked: Array<{ question: string }> = [];
  const applied: string[] = [];
  const port: SceneEditPort = {
    unavailableReason: () => options.unavailable,
    readState: () => structuredClone(state),
    async apply(commands: readonly SceneCommand[], label, id) {
      if (options.applyStatus && options.applyStatus !== "committed") return { status: options.applyStatus, message: "driver 拒绝" };
      const before = structuredClone(state);
      state = simulateSceneCommands(commands, state).after;
      options.drift?.(state);
      stack.push({ label, before });
      applied.push(label);
      return { status: "committed", receipt: { id, baseRevision: 0, finalRevision: 1, commandIds: commands.map(command => command.id) } };
    },
    capture: async () => undefined,
    async undo(label) {
      const top = stack.at(-1);
      if (!top || top.label !== label) return { ok: false, message: "栈顶不是本批" };
      state = top.before; stack.pop();
      return { ok: true };
    },
  };
  const queue = [...replies];
  const ask = async (question: string) => {
    asked.push({ question });
    const next = queue.shift();
    if (next === undefined) throw new Error("no scripted reply");
    if (next instanceof Error) throw next;
    return { text: next, model: "test-model" };
  };
  const make = (mode: SceneEditMode, maxCorrections?: number) => new SceneEditRunner(port, ask, { id: "se-abcd", objective: "把泵右移", mode, ...(maxCorrections === undefined ? {} : { maxCorrections }) });
  return { make, port, ask, asked, applied, stack, getState: () => state };
}

describe("SceneEditRunner", () => {
  it("confirm mode: previews the diff, waits, applies atomically, verifies and can undo", async () => {
    const h = harness([plan("右移", [move(4)]), verdict(true, "泵已在右侧")]);
    const runner = h.make("confirm");
    await runner.start();
    let session = runner.getState();
    expect(session.status).toBe("awaiting-approval");
    expect(session.rounds[0]!.diff!.entries[0]!.fields[0]).toMatchObject({ before: "(0, 0, 0)", after: "(4, 0, 0)" });
    expect(h.applied).toEqual([]);
    await runner.approve();
    session = runner.getState();
    expect(session.status).toBe("achieved");
    expect(session.rounds[0]!.applied!.checks.every(check => check.ok)).toBe(true);
    expect(session.rounds[0]!.applied!.undoable).toBe(true);
    expect(h.getState().objects[0]!.position).toEqual([4, 0, 0]);
    await runner.undo();
    session = runner.getState();
    expect(session.status).toBe("undone");
    expect(session.rounds[0]!.undone).toEqual({ ok: true, restored: true });
    expect(h.getState().objects[0]!.position).toEqual([0, 0, 0]);
  });

  it("plan mode never applies until the user approves", async () => {
    const h = harness([plan("右移", [move(4)]), verdict(true, "ok")]);
    const runner = h.make("plan");
    await runner.start();
    expect(runner.getState().status).toBe("plan-only");
    expect(h.applied).toEqual([]);
    await runner.approve();
    expect(h.applied).toHaveLength(1);
  });

  it("autonomous mode auto-applies and self-corrects up to the cap, then stops as unachieved", async () => {
    const h = harness([
      plan("右移 1", [move(1)]),
      verdict(false, "还不够", { summary: "再右移", commands: [move(2)] }),
      verdict(false, "仍不够", { summary: "再右移", commands: [move(3)] }),
      verdict(false, "仍不够", { summary: "不会被采用", commands: [move(9)] }),
    ]);
    const runner = h.make("autonomous", 2);
    await runner.start();
    const session = runner.getState();
    expect(session.rounds).toHaveLength(3);
    expect(h.applied).toHaveLength(3);
    expect(session.status).toBe("unachieved");
    expect(session.error).toContain("修正轮次上限");
    expect(h.getState().objects[0]!.position).toEqual([3, 0, 0]);
    await runner.undo();
    expect(h.getState().objects[0]!.position).toEqual([0, 0, 0]);
    expect(runner.getState().rounds.every(round => round.undone?.ok)).toBe(true);
  });

  it("maxCorrections=0 forbids correction even when the model offers one", async () => {
    const h = harness([plan("右移", [move(1)]), verdict(false, "不够", { summary: "x", commands: [move(2)] })]);
    const runner = h.make("autonomous", 0);
    await runner.start();
    expect(runner.getState().rounds).toHaveLength(1);
    expect(runner.getState().status).toBe("unachieved");
    expect(h.asked[1]!.question).toContain("不允许提出修正");
  });

  it("confirm mode asks for approval on every correction round", async () => {
    const h = harness([plan("右移", [move(1)]), verdict(false, "不够", { summary: "再来", commands: [move(2)] }), verdict(true, "好了")]);
    const runner = h.make("confirm", 2);
    await runner.start(); await runner.approve();
    expect(runner.getState().status).toBe("awaiting-approval");
    expect(runner.getState().rounds).toHaveLength(2);
    expect(h.applied).toHaveLength(1);
    await runner.approve();
    expect(runner.getState().status).toBe("achieved");
  });

  it("deterministic checks override a model that claims success", async () => {
    const h = harness([plan("隐藏", [{ id: "v", type: "object.set-visibility", target: { kind: "object", sceneId: "s", objectId: "a" }, visible: false }]), verdict(true, "看起来隐藏了")], {
      drift: (state) => { state.objects[0]!.visible = true; },
    });
    const runner = h.make("autonomous", 0);
    await runner.start();
    const round = runner.getState().rounds[0]!;
    expect(round.applied!.checks.filter(check => !check.ok)).toHaveLength(1);
    expect(round.verdict).toMatchObject({ outcome: "unachieved", source: "model" });
    expect(round.verdict!.reason).toContain("按未达成处理");
  });

  it("falls back to deterministic checks when the model self-check is unavailable", async () => {
    const h = harness([plan("右移", [move(1)]), new Error("模型离线")]);
    const runner = h.make("autonomous");
    await runner.start();
    expect(runner.getState().status).toBe("unverified");
    expect(runner.getState().rounds[0]!.verdict).toMatchObject({ outcome: "unverified", source: "checks" });
  });

  it("surfaces apply rollback without recording an applied round, and refuses stale previews", async () => {
    const rolled = harness([plan("右移", [move(1)])], { applyStatus: "rolled-back" });
    const first = rolled.make("autonomous");
    await first.start();
    expect(first.getState().status).toBe("failed");
    expect(first.getState().rounds[0]).toMatchObject({ status: "apply-failed" });
    expect(first.getState().rounds[0]!.applied).toBeUndefined();

    const stale = harness([plan("右移", [move(1)])]);
    const second = stale.make("confirm");
    await second.start();
    await stale.port.apply([move(7) as SceneCommand], "user-edit", "tx");
    await second.approve();
    expect(second.getState().error).toContain("差异已失效");
    expect(stale.applied).toEqual(["user-edit"]);
  });

  it("blocks plans whose targets do not exist and parse failures never touch the scene", async () => {
    const blocked = harness([plan("坏", [{ ...move(1), target: { kind: "object", sceneId: "s", objectId: "ghost" } }])]);
    const a = blocked.make("autonomous");
    await a.start();
    expect(a.getState().status).toBe("failed");
    expect(a.getState().rounds[0]!.status).toBe("blocked");
    const garbage = harness(["乱码"]);
    const b = garbage.make("autonomous");
    await b.start();
    expect(b.getState().rounds[0]!.status).toBe("parse-failed");
    expect(garbage.applied).toEqual([]);
  });

  it("autonomous mode downgrades to confirmation for irreversible runtime effects", async () => {
    const h = harness([plan("播放", [{ id: "p", type: "animation.control", target: { kind: "object", sceneId: "s", objectId: "a" }, action: "play" }])]);
    const runner = h.make("autonomous");
    await runner.start();
    expect(runner.getState().status).toBe("awaiting-approval");
    expect(runner.getState().rounds[0]!.confirmReason).toContain("不可撤销");
  });

  it("cancel aborts the in-flight model call", async () => {
    const h = harness([]);
    let seen: AbortSignal | undefined;
    const runner = new SceneEditRunner(h.port, (_q, _c, signal) => new Promise((_, reject) => { seen = signal; signal.addEventListener("abort", () => reject(new Error("aborted"))); }), { id: "se-1", objective: "x", mode: "confirm" });
    const started = runner.start();
    runner.cancel();
    await started;
    expect(seen?.aborted).toBe(true);
    expect(runner.getState().status).toBe("cancelled");
  });

  it("refuses to apply when the host is unavailable (e.g. Play mode)", async () => {
    const h = harness([plan("右移", [move(1)])], { unavailable: "Play 模式下的改动是临时态" });
    const runner = h.make("autonomous");
    await runner.start();
    expect(runner.getState().error).toContain("Play");
    expect(h.applied).toEqual([]);
  });

  it("records fingerprint-only audit receipts for apply, verification and undo, and surfaces recorder failures without blocking", async () => {
    const h = harness([plan("右移", [move(4)]), verdict(true, "ok")]);
    const records: SceneEditRecord[] = [];
    const runner = new SceneEditRunner(h.port, h.ask, { id: "se-abcd", objective: "把泵右移", mode: "autonomous" }, async (record) => { records.push(record); });
    await runner.start();
    await runner.undo();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(records.map(item => item.event)).toEqual(["applied", "verified", "undone"]);
    expect(records[0]).toMatchObject({ sessionId: "se-abcd", round: 1, mode: "autonomous", commandCount: 1, receiptId: "se-abcd-r1", checks: { total: 1, failed: 0 } });
    expect(records[0]!.planFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(records[1]).toMatchObject({ verdict: { outcome: "achieved", source: "model" } });
    expect(JSON.stringify(records)).not.toContain("泵");
    expect(runner.getState().audit).toEqual({ recorded: 3, failed: 0 });

    const failing = harness([plan("右移", [move(4)]), verdict(true, "ok")]);
    const second = new SceneEditRunner(failing.port, failing.ask, { id: "se-zzzz", objective: "x", mode: "autonomous" }, async () => { throw new Error("audit down"); });
    await second.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(second.getState().status).toBe("achieved");
    expect(second.getState().audit).toEqual({ recorded: 0, failed: 2 });
  });
});
