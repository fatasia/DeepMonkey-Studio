import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VirtualDebugSignalBinding } from "@bim-studio/contracts";
import { VirtualCommissioningTestDesignPanel } from "./VirtualCommissioningTestDesignPanel";

const bindings: VirtualDebugSignalBinding[] = ["motorRunning", "alarm", "speedSetpoint"].map((signal, index) => ({
  id: `binding-${index}`,
  signal,
  presentation: signal === "alarm" ? "alarm" : signal === "motorRunning" ? "running" : "value",
  target: { sceneId: "scene-a", objectId: "machine-a", objectKind: "model" },
}));

describe("VirtualCommissioningTestDesignPanel", () => {
  it("shows four test categories and keeps execution behind review", () => {
    const html = renderToStaticMarkup(
      <VirtualCommissioningTestDesignPanel sceneId="scene-a" bindings={bindings} durationMs={1_000} tickMs={50} speedSetpoint={1_200} />,
    );
    expect(html).toContain("测试设计助手");
    expect(html).toContain("正常");
    expect(html).toContain("边界");
    expect(html).toContain("故障");
    expect(html).toContain("恢复");
    expect(html).toContain("不会自动运行");
    expect(html).toContain("导出已确认设计");
  });
});
