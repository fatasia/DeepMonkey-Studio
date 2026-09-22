import { describe, expect, it } from "vitest";
import type { ScriptModule } from "@bim-studio/contracts";
import { analyzeSceneScript, applySceneScriptDeclarations } from "./sceneScriptAnalysis";
import { defaultBehaviorCode } from "../components/sceneBehaviorPanelModel";

const script: ScriptModule = {
  id: "behavior-1", name: "Pump", enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox",
  code: "", lifecycle: [], capabilities: [], permissions: []
};
const context = {
  targets: [
    { id: "pump-01", name: "Pump", kind: "object" as const, context: "Factory" },
    { id: "unity-01", name: "Virtual line", kind: "component" as const, runtime: "unity" as const, context: "Overview" },
  ],
  references: [{ id: "scene-1", name: "Factory", kind: "scene" as const, context: "Factory" }],
  dataKeys: ["pump.temperature"], eventNames: ["alarm"]
};

describe("analyzeSceneScript", () => {
  it("anchors missing capability and permission diagnostics to the matching source line", () => {
    const result = analyzeSceneScript(`

const target = studio.object("pump-01");
const value = studio.getData("temperature");`, { ...script, capabilities: [], permissions: [] }, context);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-capability", line: 3 }),
      expect.objectContaining({ code: "missing-permission", line: 4 }),
    ]));
  });

  it("anchors ctx.self inferred declarations and stale mount targets to the ctx.self expression", () => {
    const code = "function onStart(ctx) {\n  ctx.self?.show();\n}";
    // 能力与权限都由 ctx.self 隐式推断，规则正则命中不了，必须锚定到 ctx.self 而不是回退文件首。
    const attached = analyzeSceneScript(code, { ...script, target: { kind: "object" as const, id: "pump-01" }, capabilities: [], permissions: [] }, context);
    expect(attached.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-capability", line: 2, column: 3 }),
      expect.objectContaining({ code: "missing-permission", line: 2, column: 3 }),
    ]));

    const staleTarget = analyzeSceneScript(code, { ...script, target: { kind: "object" as const, id: "retired-pump" } }, context);
    expect(staleTarget.issues).toContainEqual(
      expect.objectContaining({ code: "unknown-reference", severity: "error", line: 2, column: 3, endColumn: 11 }),
    );
  });


  it.each([undefined, { kind: "scene" as const }, { kind: "object" as const, id: "pump-01" }, { kind: "component" as const, id: "unity-01" }])("creates a valid default script for target %j", target => {
    const analysis = analyzeSceneScript(defaultBehaviorCode(target), {
      ...script, ...(target ? { target } : {}), lifecycle: ["onStart", "onUpdate", "onDispose"],
      capabilities: ["studio.runtime", "studio.object", "studio.component"], permissions: ["scene.read", "scene.write"],
    }, context);
    expect(analysis.issues).toEqual([]);
    expect(analysis.lifecycle).toEqual(["onStart", "onUpdate", "onDispose"]);
  });

  it("locates an invalid attached API at the actual expression", () => {
    const analysis = analyzeSceneScript('function onStart(ctx) {\n  ctx.log("start");\n  ctx.self?.show();\n}', { ...script, capabilities: ["studio.runtime"] }, context);
    expect(analysis.issues).toContainEqual(expect.objectContaining({ code: "unsupported-api", line: 3, column: 3, endColumn: 11 }));
  });

  it("infers lifecycle, SDK declarations and permissions", () => {
    const analysis = analyzeSceneScript(`async function onStart(ctx) {
  const temperature = ctx.getData("pump.temperature");
  studio.object("pump-01").setColor(temperature > 80 ? "#f00" : "#0f0");
  await studio.net.fetch("https://example.com");
}`, script, context);
    expect(analysis.lifecycle).toEqual(["onStart"]);
    expect(analysis.capabilities).toEqual(expect.arrayContaining(["studio.object", "studio.data"]));
    expect(analysis.permissions).toEqual(expect.arrayContaining(["scene.write", "data.read", "network.connect"]));
    expect(analysis.missingCapabilities).toContain("studio.object");
    expect(analysis.issues.some((issue) => issue.code === "unknown-reference")).toBe(false);
  });

  it("reports stale project references with their source line", () => {
    const analysis = analyzeSceneScript(`function onStart() {
  studio.object("retired-pump").focus();
}`, script, context);
    expect(analysis.issues).toContainEqual(expect.objectContaining({ code: "unknown-reference", line: 2, message: expect.stringContaining("retired-pump") }));
  });

  it("infers Unity capability and validates Unity component references", () => {
    const analysis = analyzeSceneScript(`function onStart() {
  studio.unity("missing-unity").setProperties({ lightIntensity: 2 });
}`, script, context);
    expect(analysis.capabilities).toContain("studio.unity");
    expect(analysis.permissions).toContain("scene.write");
    expect(analysis.issues).toContainEqual(expect.objectContaining({ code: "unknown-reference", message: expect.stringContaining("missing-unity") }));
  });

  it("requires the explicit AI capability for plugin invocations", () => {
    const analysis = analyzeSceneScript(`async function onData() {
  const result = await studio.ai.invoke("maintenance.diagnose", { assetId: "pump-01" });
  studio.log("diagnosis", result);
}`, script, context);
    expect(analysis.capabilities).toEqual(expect.arrayContaining(["studio.ai", "studio.runtime"]));
    expect(analysis.missingCapabilities).toContain("studio.ai");
    expect(analysis.permissions).toContain("ai.invoke");
    expect(analysis.missingPermissions).toContain("ai.invoke");
  });

  it("treats ctx.self as the attached object and reports missing or scene-level targets", () => {
    const attachedScript = { ...script, target: { kind: "object" as const, id: "pump-01" }, capabilities: ["studio.object" as const], permissions: ["scene.write" as const] };
    const attached = analyzeSceneScript("function onStart(ctx) { ctx.self?.show(); }", attachedScript, context);
    expect(attached.capabilities).toContain("studio.object");
    expect(attached.permissions).toContain("scene.write");
    expect(attached.issues).toEqual([]);

    const missing = analyzeSceneScript("function onStart(ctx) { ctx.self?.show(); }", { ...script, target: { kind: "object", id: "retired-pump" } }, context);
    expect(missing.issues).toContainEqual(expect.objectContaining({ code: "unknown-reference", severity: "error", message: expect.stringContaining("retired-pump") }));

    const sceneLevel = analyzeSceneScript("function onStart(ctx) { ctx.self?.show(); }", { ...script, target: { kind: "scene" } }, context);
    expect(sceneLevel.issues).toContainEqual(expect.objectContaining({ code: "unsupported-api", severity: "error", message: expect.stringContaining("ctx.self") }));
  });

  it("checks project data and event names for reads, writes, emits and listeners", () => {
    const analysis = analyzeSceneScript(`function onEvent(ctx) {
  ctx.setData("retired.temperature", 0);
  ctx.emit("retired-alarm");
  if (ctx.event?.name === "missing-event") ctx.log("stale");
}`, script, context);
    expect(analysis.issues.filter((issue) => issue.code === "unknown-reference").map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("retired.temperature"),
      expect.stringContaining("retired-alarm"),
      expect.stringContaining("missing-event")
    ]));
  });

  it("adds inferred declarations without removing explicit choices", () => {
    const source: ScriptModule = { ...script, capabilities: ["studio.runtime"], permissions: ["scene.read"] };
    const analysis = analyzeSceneScript("function onUpdate() { studio.camera.setMode('orbit'); }", source, context);
    const next = applySceneScriptDeclarations(source, analysis);
    expect(next.lifecycle).toContain("onUpdate");
    expect(next.capabilities).toEqual(expect.arrayContaining(["studio.runtime", "studio.camera"]));
    expect(next.permissions).toEqual(expect.arrayContaining(["scene.read", "scene.write"]));
  });

  it("blocks trusted-only APIs in the Worker authoring surface", () => {
    const analysis = analyzeSceneScript("function onStart() { studio.scene.setWeather('rain'); engine.render(); }", script, context);
    expect(analysis.issues.filter((issue) => issue.code === "unsupported-api")).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("studio.scene") }),
      expect.objectContaining({ severity: "error", message: expect.stringContaining("engine") })
    ]);
  });

  it("忽略注释中的生命周期、引用与受限 API", () => {
    const analysis = analyzeSceneScript(`// function onUpdate() { studio.object("retired-pump").focus(); }
/* engine.render();
studio.scene.open("retired-scene"); */
function onStart() {}`, script, context);

    expect(analysis.lifecycle).toEqual(["onStart"]);
    expect(analysis.capabilities).toEqual([]);
    expect(analysis.issues).toEqual([]);
  });

  it("multi-line strings and CRLF keep diagnostics on the real source position", () => {
    // 编译器 AST 换算行列：CRLF 与模板字符串中的换行都不再靠手写切分推导。
    const analysis = analyzeSceneScript('function onStart() {\r\n  ctx.log(`multi\r\nline`);\r\n  studio.object("retired-pump").focus();\r\n}', script, context);
    // 锚定到字符串字面量本身：line 4 col 18 = "retired-pump" 的起始位置。
    expect(analysis.issues).toContainEqual(expect.objectContaining({ code: "unknown-reference", line: 4, column: 18, endColumn: 30 }));
  });
});
