import { describe, expect, it } from "vitest";
import { createSdkExampleScript, sdkExampleUnavailableReason } from "./sdkExampleInsertion";
import { resolveSceneBehaviorModule } from "./scriptModuleAdapter";
import { SDK_EXAMPLES, type SdkExampleId } from "../docs/sdkExamples";

describe("SDK example insertion", () => {
  it("prepares independent files accepted by the current Worker module contract", () => {
    const scripts = SDK_EXAMPLES.map(example => createSdkExampleScript(example.id, [], () => `new:${example.id}`));
    expect(new Set(scripts.map(script => script.id)).size).toBe(SDK_EXAMPLES.length);
    for (const script of scripts) {
      expect(resolveSceneBehaviorModule(script).status).toBe("ready");
      expect(script.target).toEqual({ kind: "scene" });
      expect(script.permissions).not.toEqual(expect.arrayContaining(["scene.write"]));
      expect(script.permissions).not.toEqual(expect.arrayContaining(["data.write"]));
    }
  });

  it("preserves every existing file and draft while numbering normalized name collisions", () => {
    const first = createSdkExampleScript("lifecycle", [], () => "first");
    const source = [{ ...first, name: " SDK-LIFECYCLE.JS ", code: "UNSAVED DRAFT" }, { ...first, id: "second", name: "sdk-lifecycle-2.js" }];
    const baseline = structuredClone(source);
    const inserted = createSdkExampleScript("lifecycle", source, () => "third");
    expect(inserted.name).toBe("sdk-lifecycle-3.js");
    expect(source).toEqual(baseline);
    inserted.capabilities.push("studio.data");
    expect(SDK_EXAMPLES[0]!.capabilities).toEqual(["studio.runtime"]);
  });

  it("rejects an unknown example or colliding ID without modifying files", () => {
    const existing = createSdkExampleScript("lifecycle", [], () => "same");
    expect(() => createSdkExampleScript("unknown" as SdkExampleId, [])).toThrow("样例已不可用");
    expect(() => createSdkExampleScript("lifecycle", [existing], () => "same")).toThrow("独立脚本标识");
    expect(() => createSdkExampleScript("lifecycle", [], () => "")).toThrow("独立脚本标识");
  });

  it("makes login, missing project/application and temporary blockers explicit", () => {
    expect(sdkExampleUnavailableReason({ authenticated: false })).toContain("请先登录");
    expect(sdkExampleUnavailableReason({ authenticated: true })).toContain("请先打开项目");
    expect(sdkExampleUnavailableReason({ authenticated: true, projectId: "p" })).toContain("请先打开项目");
    expect(sdkExampleUnavailableReason({ authenticated: true, projectId: "p", applicationId: "a", unavailableReason: "正在加载应用" })).toBe("正在加载应用");
    expect(sdkExampleUnavailableReason({ authenticated: true, projectId: "p", applicationId: "a" })).toBeUndefined();
  });
});
