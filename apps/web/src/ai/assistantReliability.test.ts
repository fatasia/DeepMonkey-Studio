import { describe, expect, it } from "vitest";
import {
  assistantReliabilityFromResponse,
  assistantWorkspaceTarget,
  queryCapabilityReliability,
  sourceFromSettled,
} from "./assistantReliability";

describe("assistantReliability", () => {
  it("keeps the same scene and selected object identity used by the request", () => {
    expect(
      assistantWorkspaceTarget({
        project: { id: "project-1", name: "电池工厂" },
        scene: { id: "scene-2", name: "装配线", modelCount: 3 },
        selected: { id: "robot-7", name: "焊接机器人", kind: "model" },
        script: { id: "script-1", name: "启动联锁", language: "typescript", revision: 4 },
        simulation: { studyId: "study-1", name: "启动黄金矩阵", status: "passed" },
        dashboard: { widgets: [{ id: "risk" }] },
      }),
    ).toEqual({
      project: { id: "project-1", name: "电池工厂" },
      workspace: "scene",
      scene: { id: "scene-2", name: "装配线", modelCount: 3 },
      selected: { id: "robot-7", name: "焊接机器人", kind: "model" },
      script: { id: "script-1", name: "启动联锁", language: "typescript", revision: 4 },
      simulation: { id: "study-1", name: "启动黄金矩阵", status: "passed" },
      dashboardWidgetCount: 1,
    });
  });

  it("only marks a response verified when server metadata includes execution evidence", () => {
    const result = assistantReliabilityFromResponse(
      {
        reliability: {
          traceId: "trace-1",
          verification: "verified",
          contextTrust: "capability-result",
          evidenceCount: 2,
          inputRisk: "low",
          writePolicy: "read-only",
          contextFingerprint: "sha256:evidence",
          warnings: [],
        },
      },
      "operations",
      [{ id: "operations", label: "运营模型", state: "ready", kind: "snapshot" }],
    );

    expect(result.grade).toBe("capability-verified");
    expect(result.contextTrust).toBe("capability-result");
    expect(result.traceId).toBe("trace-1");
  });

  it("downgrades an ordinary model answer to a context-supported snapshot", () => {
    const result = assistantReliabilityFromResponse(
      { text: "建议检查温度趋势" },
      "scene",
      [{ id: "scene", label: "当前场景", state: "ready", kind: "snapshot" }],
    );

    expect(result.grade).toBe("context-supported");
    expect(result.contextTrust).toBe("client-snapshot");
    expect(result.evidenceCount).toBe(0);
    expect(result.fallbackReason).toBe("no-capability-evidence");
  });

  it("preserves trace and fingerprint for a controlled data Capability", () => {
    const result = queryCapabilityReliability({
      traceId: "trace-query",
      evidenceCount: 1,
      evidenceFingerprint: "sha256:query",
      sourceLabel: "设备温度",
    });

    expect(result).toMatchObject({
      grade: "capability-verified",
      contextTrust: "capability-result",
      traceId: "trace-query",
      contextFingerprint: "sha256:query",
      writePolicy: "read-only",
    });
  });

  it("exposes a failed snapshot source instead of silently treating fallback data as real", () => {
    const source = sourceFromSettled(
      "vision",
      "视觉事件",
      { status: "rejected", reason: new Error("offline") },
      (items: unknown[]) => items.length,
    );

    expect(source).toMatchObject({ state: "unavailable", kind: "snapshot" });
  });
});
