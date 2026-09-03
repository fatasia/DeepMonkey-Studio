import { describe, expect, it } from "vitest";
import { createImportedBehaviorScript, scriptDownloadFileName } from "./scriptFileTransfer";

describe("script file transfer", () => {
  it("将每个 JS 保持为独立行为模块并识别生命周期", async () => {
    const result = await createImportedBehaviorScript(new File(["export function onData(ctx) { ctx.log('ok'); }"], "sensor.mjs"), { kind: "object", id: "pump-1" });
    expect(result).toMatchObject({ name: "sensor", code: expect.stringContaining("onData"), lifecycle: ["onData"], target: { kind: "object", id: "pump-1" } });
  });

  it("生成 Windows 可用的下载文件名", () => {
    expect(scriptDownloadFileName("AGV: route / line 1")).toBe("AGV- route - line 1.js");
  });
});
