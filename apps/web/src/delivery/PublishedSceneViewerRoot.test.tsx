import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PublishedSceneViewerRoot } from "./PublishedSceneViewerRoot";

/**
 * 匿名 Web 发布场景页(/published/:sceneId)的回归保护:
 * - 路由合同:未登录访客在 AppRootView 中必须先于登录页进入匿名查看页;
 * - 组件合同:无效链接给可读错误态;加载态可感知(不复现登录页拦截回归)。
 * 真实浏览器渲染(引擎装载、公开端点联通)由 test-output/ui-audit-round2 探针覆盖。
 */

const rootViewTsx = readFileSync(resolve(import.meta.dirname, "../views/AppRootView.tsx"), "utf8");

describe("published scene anonymous viewer contract", () => {
  it("routes anonymous published visitors to the read-only viewer before the login page", () => {
    const branchIndex = rootViewTsx.indexOf('route.view === "published" && !currentUser');
    const loginIndex = rootViewTsx.indexOf("<LoginPage");
    expect(branchIndex).toBeGreaterThan(-1);
    expect(loginIndex).toBeGreaterThan(branchIndex);
    expect(rootViewTsx).toContain("PublishedSceneViewerRoot");
  });

  it("renders a perceivable loading state before the publication arrives", () => {
    const html = renderToStaticMarkup(<PublishedSceneViewerRoot sceneId="scene-1" />);
    expect(html).toContain("正在加载发布场景");
    expect(html).not.toContain("input");
  });

  it("rejects an invalid publication link with a readable error path", () => {
    // 错误态由 effect 触发（SSR 不执行），此处锁空 sceneId 的守卫与文案合同。
    const source = readFileSync(resolve(import.meta.dirname, "PublishedSceneViewerRoot.tsx"), "utf8");
    expect(source).toContain("发布链接无效，请检查场景地址。");
    expect(source).toContain("if (!sceneId?.trim())");
  });
});
