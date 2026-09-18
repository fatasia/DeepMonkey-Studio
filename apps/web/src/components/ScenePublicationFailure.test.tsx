import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScenePublicationCompatibilityReport, PublicationCapabilityItem } from "@bim-studio/contracts";
import { ScenePublicationFailure } from "./ScenePublicationFailure";

function report(items: PublicationCapabilityItem[], target: "deep-native" | "three-webview" = "deep-native"): ScenePublicationCompatibilityReport {
  return { schemaVersion: 1, target, sceneId: "scene-id", contentFingerprint: "a".repeat(64),
    compileGraphHash: "b".repeat(64), targetArtifactHash: "c".repeat(64), fixtureId: "test", platform: "windows-x64",
    capabilityProfileVersion: "test-v1", status: "blocked", items, evidence: [] };
}
function issue(index: number, status: PublicationCapabilityItem["status"] = "blocked"): PublicationCapabilityItem {
  return { sceneId: "scene-id", objectId: index === 0 ? "scene-id" : `object-${index}`, path: index === 0 ? "environment" : `models[${index}]`,
    capability: "test", status, reason: `reason-${index}`, remediation: `fix-${index}`, evidenceIds: [] };
}

describe("publication failure presentation", () => {
  it("summarizes failures and keeps every diagnostic in a closed native disclosure", () => {
    const items = Array.from({ length: 12 }, (_, index) => issue(index));
    const html = renderToStaticMarkup(<ScenePublicationFailure message="truncated fallback" report={report(items)} sceneName="装配场景" locale="zh-CN" />);
    expect(html).toContain('role="alert">有 12 项内容未通过发布检查。');
    expect(html).toContain("<details><summary>查看全部问题</summary><ol>");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("truncated fallback");
    expect(html).toContain("装配场景 · 场景环境");
    expect(html.match(/<li>/g)).toHaveLength(12);
    for (let index = 0; index < 12; index++) {
      expect(html).toContain(`reason-${index}`); expect(html).toContain(`fix-${index}`);
    }
    expect(html).toContain("object-11 · models[11]");
  });
  it("includes degraded and Native WebView-only issues but excludes supported entries", () => {
    const items = [issue(0), issue(1, "degraded"), issue(2, "webview-only"), issue(3, "supported")];
    const html = renderToStaticMarkup(<ScenePublicationFailure message="fallback" report={report(items)} sceneName="Scene" locale="en-US" />);
    expect(html).toContain("3 items did not pass publication checks.");
    expect(html).toContain("Review all issues"); expect(html).toContain("Scene · Environment");
    expect(html).not.toContain("reason-3");
    const webview = renderToStaticMarkup(<ScenePublicationFailure message="fallback" report={report(items, "three-webview")} sceneName="Scene" locale="en-US" />);
    expect(webview).toContain("2 items did not pass publication checks."); expect(webview).not.toContain("reason-2");
  });
  it.each([undefined, report([]), report([issue(1, "supported")])])("keeps ordinary errors visible without an empty disclosure", value => {
    const html = renderToStaticMarkup(<ScenePublicationFailure message="503：构建服务不可用，请重试" {...(value ? { report: value } : {})} sceneName="场景" locale="zh-CN" />);
    expect(html).toContain('role="alert">503：构建服务不可用，请重试'); expect(html).not.toContain("<details");
  });
  it("renders diagnostic and scene names as text, never as executable markup", () => {
    const unsafe = { ...issue(0), reason: '<img src=x onerror="alert(1)">', remediation: "<script>bad()</script>" };
    const html = renderToStaticMarkup(<ScenePublicationFailure message="fallback" report={report([unsafe])} sceneName="<b>name</b>" locale="zh-CN" />);
    expect(html).not.toContain("<img"); expect(html).not.toContain("<script>"); expect(html).toContain("&lt;b&gt;name&lt;/b&gt;");
  });
});
