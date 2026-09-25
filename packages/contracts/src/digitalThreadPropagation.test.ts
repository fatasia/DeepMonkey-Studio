import { describe, expect, it } from "vitest";
import {
  bumpObjectVersion,
  createObjectHeader,
  diagnoseDigitalThread,
  fingerprintDigitalThreadObject,
  type DigitalThreadObject,
} from "./digitalThread.js";

const AT = "2026-09-25T21:00:00.000Z";

/** golden-09 最简单线:source→station→sink;本文件只验证数字线程传播语义,不驱动引擎。 */
function buildStudy(stableId: string): DigitalThreadObject {
  return {
    ...createObjectHeader({ stableId, kind: "simulation-study", at: AT }),
    payload: {
      engineId: "plant-lite-des",
      model: {
        id: "g09-line",
        name: "G09 单线",
        nodes: [
          { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 10 } },
          { id: "station", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 3 } },
          { id: "snk", name: "出货", kind: "sink" },
        ],
        edges: [
          { id: "e1", from: "src", to: "station" },
          { id: "e2", from: "station", to: "snk" },
        ],
      },
      seed: "g09-seed",
    },
  };
}

function buildStudyResult(stableId: string, studyStableId: string): DigitalThreadObject {
  return {
    ...createObjectHeader({ stableId, kind: "study-result", at: AT }),
    payload: { studyRecordId: studyStableId },
  };
}

function buildBaseline(stableId: string, entryStableId: string, entryVersion: number): DigitalThreadObject {
  return {
    ...createObjectHeader({ stableId, kind: "release-baseline", at: AT }),
    payload: { entries: [{ stableId: entryStableId, version: entryVersion }], approvedBy: "g09-approver" },
  };
}

describe("golden-09 变更传播", () => {
  it("Study v1 + 结果引用 + 基线冻结 v1 零诊断", () => {
    const study = buildStudy("g09-study");
    const result = buildStudyResult("g09-result", "g09-study");
    const baseline = buildBaseline("g09-baseline", "g09-study", 1);
    expect(study.version).toBe(1);
    expect(diagnoseDigitalThread([study, result, baseline])).toEqual([]);
  });

  it("Study 升 v2 后基线仍记 v1,暴露 baseline-version-mismatch", () => {
    const studyV2 = bumpObjectVersion(buildStudy("g09-study"), { at: AT, summary: "换型时间调整" });
    const result = buildStudyResult("g09-result", "g09-study");
    const baseline = buildBaseline("g09-baseline", "g09-study", 1);
    const diagnostics = diagnoseDigitalThread([studyV2, result, baseline]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.kind).toBe("baseline-version-mismatch");
    expect(diagnostics[0]!.fromStableId).toBe("g09-baseline");
    expect(diagnostics[0]!.toStableId).toBe("g09-study");
    expect(diagnostics[0]!.message).toContain("基线记录 v1");
    expect(diagnostics[0]!.message).toContain("当前 v2");
  });

  it("删除 Study 只进断链诊断:结果引用与基线各自报 broken-link,不静默改绑", () => {
    const result = buildStudyResult("g09-result", "g09-study");
    const baseline = buildBaseline("g09-baseline", "g09-study", 1);
    const diagnostics = diagnoseDigitalThread([result, baseline]);
    // 基线缺失目标按合同产出两条:通用 baseline-entry 链断链 + 专用基线引用断裂。
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((item) => item.kind === "broken-link")).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      kind: "broken-link", fromStableId: "g09-result", toStableId: "g09-study",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      kind: "broken-link", fromStableId: "g09-baseline", toStableId: "g09-study",
    }));
    expect(diagnostics.some((item) => item.message.startsWith("基线引用断裂"))).toBe(true);
    expect(diagnostics.some((item) => item.kind === "baseline-version-mismatch")).toBe(false);
  });

  it("版本变化必然改变对象指纹:v1 ≠ v2", () => {
    const studyV1 = buildStudy("g09-study");
    const studyV2 = bumpObjectVersion(studyV1, { at: AT, summary: "换型时间调整" });
    const fingerprintV1 = fingerprintDigitalThreadObject(studyV1);
    const fingerprintV2 = fingerprintDigitalThreadObject(studyV2);
    expect(fingerprintV1).not.toBe(fingerprintV2);
    expect(fingerprintV1).toBe(fingerprintDigitalThreadObject(buildStudy("g09-study")));
  });
});
