import type { VirtualDebugResult } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VirtualCommissioningEvidence } from "./VirtualCommissioningEvidence";

describe("VirtualCommissioningEvidence", () => {
  it("labels a passing run as control-logic evidence instead of precise robot simulation", () => {
    const html = renderResult(resultFixture("passed"));
    expect(html).toContain("控制逻辑断言通过");
    expect(html).toContain("只覆盖当前 I/O 状态机");
    expect(html).toContain("不覆盖完整 IK、网格级连续碰撞或真实控制器时序");
    expect(html).not.toContain(">验收通过<");
  });

  it("keeps a failed assertion connected to its scene object", () => {
    const html = renderResult(resultFixture("failed"));
    expect(html).toContain("1 项控制逻辑断言未通过");
    expect(html).toContain("定位设备");
    expect(html).toContain("robot-1");
  });
});

function renderResult(output: VirtualDebugResult): string {
  return renderToStaticMarkup(<VirtualCommissioningEvidence
    invocation={{
      status: "completed", decisionStatus: "research-candidate",
      capabilityId: "simulation.virtual-debug.run", pluginId: "simulation.virtual-debug", capabilityVersion: "1.0.0",
      requestId: "request-1", traceId: "trace-1", generatedAt: "2026-09-03T00:00:00.000Z", durationMs: 1,
      evidence: [], warnings: [], suggestedActions: [], output,
    }}
    playheadMs={0}
    onPlayheadChange={vi.fn()}
    onExport={vi.fn()}
    onOpenTarget={vi.fn()}
  />);
}

function resultFixture(status: "passed" | "failed"): VirtualDebugResult {
  const target = { sceneId: "scene-1", objectId: "robot-1", objectKind: "model" as const };
  return {
    status, scenarioId: "robot-control-1", tickMs: 50, durationMs: 1000,
    trace: [{ atMs: 0, state: "idle", signals: { alarm: false }, events: [] }],
    bindings: [{ id: "alarm-binding", signal: "alarm", presentation: "alarm", target }],
    failures: status === "failed" ? [{ assertionId: "alarm-reset", atMs: 0, message: "告警未复位", target }] : [],
    evidenceFingerprint: "virtual-evidence-1",
  };
}
