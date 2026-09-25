import { describe, expect, it } from "vitest";
import {
  bumpObjectVersion,
  collectThreadLinks,
  createObjectHeader,
  DigitalThreadIdentityError,
  diagnoseDigitalThread,
  fingerprintDigitalThreadObject,
  setObjectStatus,
  type DigitalThreadObject,
} from "./digitalThread.js";

const AT = "2026-09-25T20:00:00.000Z";

function buildProduct(stableId: string): DigitalThreadObject {
  return {
    ...createObjectHeader({ stableId, kind: "product-definition", at: AT }),
    payload: {
      rootComponent: { id: `${stableId}-root`, name: "整机", kind: "product" },
    },
  };
}

function buildStudy(stableId: string, seed: string | number): DigitalThreadObject {
  return {
    ...createObjectHeader({ stableId, kind: "simulation-study", at: AT }),
    payload: {
      engineId: "plant-lite-des",
      model: {
        nodes: [
          { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
          { id: "snk", name: "出货", kind: "sink" },
        ],
        edges: [{ id: "e1", from: "src", to: "snk" }],
        resources: [],
        durationMinutes: 60,
      },
      seed,
    },
  };
}

describe("digitalThread 对象头与版本", () => {
  it("stableId 必须路径安全", () => {
    expect(() => createObjectHeader({ stableId: "a/b c", kind: "product-definition", at: AT }))
      .toThrow(DigitalThreadIdentityError);
  });

  it("bump 递增版本并追加变更记录,原对象不被修改", () => {
    const product = buildProduct("prod-a");
    const bumped = bumpObjectVersion(product, { at: AT, summary: "改型" });
    expect(bumped.version).toBe(2);
    expect(bumped.changeLog).toHaveLength(2);
    expect(bumped.changeLog[1]?.summary).toBe("改型");
    expect(bumped.updatedAt).toBe(AT);
    expect(product.version).toBe(1);
    expect(product.changeLog).toHaveLength(1);
  });

  it("frozen 对象拒绝直接修改", () => {
    const frozen = setObjectStatus(buildProduct("prod-b"), "frozen", { at: AT, summary: "冻结" });
    expect(frozen.status).toBe("frozen");
    expect(() => bumpObjectVersion(frozen, { at: AT, summary: "偷改" })).toThrow(DigitalThreadIdentityError);
  });
});

describe("digitalThread 断链诊断", () => {
  it("断裂引用被报告且不改写对象", () => {
    const study = buildStudy("study-a", "s1");
    const result: DigitalThreadObject = {
      ...createObjectHeader({ stableId: "result-a", kind: "study-result", at: AT }),
      payload: { studyRecordId: "study-deleted" },
    };
    const diagnostics = diagnoseDigitalThread([study, result]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe("broken-link");
    expect(diagnostics[0]?.fromStableId).toBe("result-a");
    expect(diagnostics[0]?.toStableId).toBe("study-deleted");
  });

  it("重复与非法 stableId 都进诊断", () => {
    const objects = [buildStudy("study-a", 1), buildStudy("study-a", 2)];
    objects.push({ ...objects[0]!, stableId: "bad id" });
    const diagnostics = diagnoseDigitalThread(objects);
    expect(diagnostics.some((item) => item.kind === "duplicate-stable-id")).toBe(true);
    expect(diagnostics.some((item) => item.kind === "invalid-stable-id")).toBe(true);
  });

  it("基线版本漂移被暴露为独立诊断类别", () => {
    const product = buildProduct("prod-c");
    const bumped = bumpObjectVersion(product, { at: AT, summary: "v2" });
    const baseline: DigitalThreadObject = {
      ...createObjectHeader({ stableId: "baseline-a", kind: "release-baseline", at: AT }),
      payload: { entries: [{ stableId: "prod-c", version: 1 }] },
    };
    const diagnostics = diagnoseDigitalThread([bumped, baseline]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe("baseline-version-mismatch");
  });

  it("健康线程零诊断,links 由 payload 推导", () => {
    const scenario: DigitalThreadObject = {
      ...createObjectHeader({ stableId: "ctrl-a", kind: "control-scenario", at: AT }),
      payload: {
        scenario: { id: "sc-1", durationMs: 1000, commands: [{ atMs: 0, type: "start" }] },
      },
    };
    const validation: DigitalThreadObject = {
      ...createObjectHeader({ stableId: "valid-a", kind: "validation-case", at: AT }),
      payload: { kind: "virtual-debug", scenarioStableId: "ctrl-a" },
    };
    expect(diagnoseDigitalThread([scenario, validation])).toEqual([]);
    expect(collectThreadLinks([validation])).toEqual([
      { fromStableId: "valid-a", toStableId: "ctrl-a", role: "control-scenario" },
    ]);
  });
});

describe("digitalThread 指纹", () => {
  it("同对象恒同指纹;payload 或版本变化改变指纹", () => {
    const a = buildStudy("study-f", "seed-1");
    const b = buildStudy("study-f", "seed-1");
    expect(fingerprintDigitalThreadObject(a)).toBe(fingerprintDigitalThreadObject(b));
    const changedSeed = buildStudy("study-f", "seed-2");
    expect(fingerprintDigitalThreadObject(a)).not.toBe(fingerprintDigitalThreadObject(changedSeed));
    expect(fingerprintDigitalThreadObject(a))
      .not.toBe(fingerprintDigitalThreadObject(bumpObjectVersion(a, { at: AT, summary: "touch" })));
  });
});
