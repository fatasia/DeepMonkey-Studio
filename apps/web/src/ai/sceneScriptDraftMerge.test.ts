import { describe, expect, it } from "vitest";
import { buildSceneScriptDiff, mergeSceneScriptLifecycle } from "./sceneScriptDraftMerge";

describe("sceneScriptDraftMerge", () => {
  it("does not inject into a lifecycle example inside comments or strings", () => {
    const source = `// function onStart(ctx) { example(); }
const note = "function onStart(ctx) { fake(); }";`;
    const merged = mergeSceneScriptLifecycle(source, "onStart", ["ctx.log(\"real\");"]);

    expect(merged.error).toBeUndefined();
    expect(merged.code).toContain('const note = "function onStart(ctx) { fake(); }";');
    expect(merged.code).toMatch(/\nfunction onStart\(ctx\) \{\n  ctx\.log\("real"\);\n\}\n$/);
  });

  it("refuses expression lifecycles instead of guessing an insertion boundary", () => {
    const merged = mergeSceneScriptLifecycle("const onStart = (ctx) => ctx.log('existing');", "onStart", ["ctx.log('new');"]);

    expect(merged.code).toBeUndefined();
    expect(merged.error).toContain("表达式声明");
  });

  it("does not count a phantom removed line for an empty script", () => {
    const diff = buildSceneScriptDiff("", "function onStart(ctx) {\n  ctx.log('ready');\n}\n", ["onStart"]);

    expect(diff.removedLines).toBe(0);
    expect(diff.addedLines).toBe(4);
  });
});
