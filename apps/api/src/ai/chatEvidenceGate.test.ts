import { describe, expect, it } from "vitest";
import { auditFingerprint } from "./aiReliabilityAudit.js";
import { anchorChatAnswerEvidence, auditChatAnswerEvidence } from "./chatEvidenceGate.js";

/**
 * K2 回归锁（AI 助手交互与可靠性深度审计 20260929 §一 K2）：
 * 服务端此前对客户端快照零复核，答案中的数值/编号是否来自上下文无从知晓。
 * 以下断言锁死出域复核器的确定性比对行为——这条路径以前完全不存在。
 */
describe("chatEvidenceGate (K2 answer token audit)", () => {
  it("separates grounded tokens from fabricated ones", () => {
    const audit = auditChatAnswerEvidence(
      "设备 EQ-2205 的故障率为 87.3%，建议立即检修泵 P101。",
      JSON.stringify({ devices: [{ id: "EQ-2205", tag: "P101" }] }),
    );
    expect(audit.checked).toBe(3);
    expect(audit.matched).toEqual(["EQ-2205", "P101"]);
    expect(audit.unmatched).toEqual(["87.3"]);
  });

  it("treats a comma-formatted number and its plain form as the same evidence", () => {
    const audit = auditChatAnswerEvidence("本季产量 1,250 台，同比提升 13%。",
      JSON.stringify({ output: { units: 1250, growth: 0.12 } }));
    expect(audit.matched).toEqual(["1,250"]);
    expect(audit.unmatched).toEqual(["13"]);
  });

  it("ignores single-digit counts that mostly enumerate lists", () => {
    const audit = auditChatAnswerEvidence("有 3 个原因：1. 温度 2. 振动 3. 润滑。", JSON.stringify({}));
    expect(audit.checked).toBe(0);
    expect(audit.matched).toEqual([]);
    expect(audit.unmatched).toEqual([]);
  });

  it("reports every token as unmatched against an empty context", () => {
    const audit = auditChatAnswerEvidence("效率 96.5%，振动 7.8 mm/s。", "");
    expect(audit.checked).toBe(2);
    expect(audit.matched).toEqual([]);
    expect(audit.unmatched).toEqual(["96.5", "7.8"]);
  });

  it("keeps plain prose free of any audit noise", () => {
    const audit = auditChatAnswerEvidence("建议先检查润滑状态，再复测振动。", JSON.stringify({ note: "润滑" }));
    expect(audit).toEqual({ checked: 0, matched: [], unmatched: [] });
  });

  it("caps audited tokens to bound cost and warning noise", () => {
    const answer = Array.from({ length: 40 }, (_, index) => `值${index} 为 ${index + 10}。`).join("");
    const audit = auditChatAnswerEvidence(answer, "");
    expect(audit.checked).toBe(24);
    expect(audit.unmatched).toHaveLength(24);
  });
});

/**
 * T5 回归锁（H-C5-T5 逐条引用与真正证据锚对齐 20261003）：
 * 引用锚必须落在来源**已发送窗口内**且指纹可复核——窗口外/无来源一律不出锚，
 * 防伪造引用与引用漂移；锚坐标系与 contextDelivery 一致（utf16 源内偏移）。
 */
describe("anchorChatAnswerEvidence (T5 per-item citation anchors)", () => {
  const source = (id: string, text: string, sentChars = text.length) => ({ id, path: id, start: 0, text, sentChars });

  it("anchors a matched token to the exact source offset with a verifiable fingerprint", () => {
    const text = JSON.stringify({ devices: [{ id: "EQ-2205", score: 92 }] });
    const citations = anchorChatAnswerEvidence("设备 EQ-2205 健康分 92，建议检修。", [source("workspace-scene", text)]);
    expect(citations).toHaveLength(2);
    const byToken = new Map(citations.map((citation) => [citation.token, citation]));
    expect(byToken.get("EQ-2205")).toEqual({
      token: "EQ-2205",
      anchors: [{ sourceId: "workspace-scene", sourcePath: "workspace-scene", offset: text.indexOf("EQ-2205"), fingerprint: auditFingerprint(text) }],
    });
    expect(byToken.get("92")?.anchors[0].offset).toBe(text.indexOf("92"));
  });

  it("refuses anchors beyond the sent window of a partially sent source", () => {
    const text = '{"head":"P101","tail":"EQ-9900"}';
    const citations = anchorChatAnswerEvidence("P101 与 EQ-9900 均需复核。", [source("datasets", text, text.indexOf('"tail"'))]);
    expect(citations.map((citation) => citation.token)).toEqual(["P101"]);
  });

  it("collects one anchor per source when several sources contain the token", () => {
    const first = '{"tag":"P101"}';
    const second = '{"device":"P101"}';
    const citations = anchorChatAnswerEvidence("泵 P101。", [source("datasets", first), source("bim-evidence", second)]);
    expect(citations).toHaveLength(1);
    expect(citations[0].anchors.map((anchor) => anchor.sourceId)).toEqual(["datasets", "bim-evidence"]);
    expect(citations[0].anchors[0].fingerprint).toBe(auditFingerprint(first));
    expect(citations[0].anchors[1].fingerprint).toBe(auditFingerprint(second));
  });

  it("anchors comma-formatted values via their plain variant and yields nothing without sources", () => {
    const text = '{"units":1250}';
    const citations = anchorChatAnswerEvidence("本季 1,250 台。", [source("datasets", text)]);
    expect(citations[0].token).toBe("1,250");
    expect(citations[0].anchors[0].offset).toBe(text.indexOf("1250"));
    expect(anchorChatAnswerEvidence("本季 1,250 台。", [])).toEqual([]);
  });
});
