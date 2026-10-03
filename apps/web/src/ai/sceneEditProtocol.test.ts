import { describe, expect, it } from "vitest";
import { buildProposalPrompt, buildVerdictPrompt, parseProposal, parseVerdict } from "./sceneEditProtocol";
import type { SceneStateSnapshot } from "./sceneEditState";

const state: SceneStateSnapshot = {
  sceneId: "scene-1", objects: [{ id: "a", name: "泵", kind: "primitive", visible: true, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
  camera: { position: [0, 0, 8], target: [0, 0, 0] }, lighting: {}, environment: {},
};
const cmd = { type: "object.set-visibility", target: { kind: "object", sceneId: "wrong", objectId: "a" }, visible: false };

describe("scene edit protocol", () => {
  it("parses fenced JSON, pins sceneId to the active scene and namespaces ids", () => {
    const parsed = parseProposal("```json\n" + JSON.stringify({ summary: "隐藏泵", commands: [{ id: "x", ...cmd }, cmd] }) + "\n```", "scene-1", "r1-");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary).toBe("隐藏泵");
    expect(parsed.commands.map(command => command.id)).toEqual(["r1-x", "r1-c2"]);
    expect(parsed.commands[0]).toMatchObject({ target: { sceneId: "scene-1" } });
  });

  it("extracts JSON surrounded by prose, including escaped quotes in strings", () => {
    const text = `好的:{"summary":"说 \\"你好\\" {x}","commands":[]} 以上。`;
    const parsed = parseProposal(text, "scene-1", "r1-");
    expect(parsed).toEqual({ ok: true, summary: '说 "你好" {x}', commands: [] });
  });

  it("rejects invalid commands, oversize batches and non-JSON with readable reasons", () => {
    expect(parseProposal("没有 JSON", "scene-1", "r1-")).toEqual({ ok: false, error: "模型输出不是合法 JSON" });
    const invalid = parseProposal(JSON.stringify({ commands: [{ id: "1", type: "object.set-visibility", target: { kind: "object", sceneId: "s", objectId: "a" }, visible: "no" }] }), "scene-1", "r1-");
    expect(invalid.ok).toBe(false);
    const many = parseProposal(JSON.stringify({ commands: Array.from({ length: 13 }, (_, index) => ({ id: String(index), ...cmd })) }), "scene-1", "r1-");
    expect(many).toMatchObject({ ok: false, error: expect.stringContaining("超过上限 12") });
    expect(parseProposal(JSON.stringify({ summary: "x" }), "scene-1", "r1-")).toMatchObject({ ok: false });
  });

  it("parses verdicts and only keeps corrections when not achieved", () => {
    const correction = { summary: "再改", commands: [cmd] };
    const unachieved = parseVerdict(JSON.stringify({ achieved: false, reason: "位置不对", correction }), "scene-1", "r2-");
    expect(unachieved?.achieved).toBe(false);
    expect(unachieved?.correction).toMatchObject({ ok: true });
    expect(parseVerdict(JSON.stringify({ achieved: true, reason: "ok", correction }), "scene-1", "r2-")?.correction).toBeUndefined();
    expect(parseVerdict("{\"reason\":1}", "scene-1", "r2-")).toBeUndefined();
  });

  it("builds prompts that carry the contract, compact state and observation facts", () => {
    const proposal = buildProposalPrompt({ objective: "隐藏泵", state });
    expect(proposal.question).toContain("object.set-transform");
    expect(proposal.question).toContain("目标:隐藏泵");
    expect(proposal.context).toMatchObject({ sceneEdit: { sceneId: "scene-1", objects: [{ id: "a" }] } });
    const retry = buildProposalPrompt({ objective: "隐藏泵", state, correction: { summary: "s", reason: "r", failedChecks: ["泵 · 可见性"] } });
    expect(retry.question).toContain("核对失败:泵 · 可见性");
    const verdict = buildVerdictPrompt({
      objective: "隐藏泵", summary: "s", diff: { entries: [], counts: { add: 0, modify: 0, delete: 0, action: 0 }, blockers: [], irreversibleCount: 0 },
      checks: [{ key: "k", label: "泵 · 可见性", expected: "否", actual: "否", ok: true }], state, touchedIds: ["a"],
      viewport: { width: 1920, height: 1080, meanLuma: 12.3, contentRatio: 0.2, grid: [1, 2, 3, 4, 5, 6, 7, 8, 9], fingerprint: "ff" }, correctionsLeft: 0,
    });
    expect(verdict.question).toContain("不允许提出修正");
    expect(verdict.context).toMatchObject({ sceneVerify: { viewport: { meanLuma: 12.3 }, objectsAfter: [{ id: "a" }] } });
  });
});
