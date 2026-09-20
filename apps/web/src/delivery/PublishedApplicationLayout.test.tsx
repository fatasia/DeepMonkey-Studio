import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 批次 E A4 附带发现的回归保护：发布头栏为 fixed 浮层，应用内容必须经
 * .published-application-content 容器让出头部高度（padding-top: 56px），
 * 否则 1440×900 下页顶组件（返回导航等）被头栏遮挡（复现：重叠 23.6px）。
 * 布局是 CSS 合同（非 JS 逻辑），此处锁「DOM 结构与 CSS 规则同时在场」。
 */

const rootTsx = readFileSync(resolve(import.meta.dirname, "PublishedApplicationRoot.tsx"), "utf8");
const css = readFileSync(resolve(import.meta.dirname, "published-application.css"), "utf8");

describe("published application layout contract", () => {
  it("wraps playback content in the reservation container", () => {
    expect(rootTsx).toContain('className="published-application-content"');
    // 容器必须包住 DashboardPlayback（让位作用于内容而非浮层）。
    const contentIndex = rootTsx.indexOf('className="published-application-content"');
    const playbackIndex = rootTsx.indexOf("<DashboardPlayback");
    const creditsIndex = rootTsx.indexOf("<PublishedModelCredits");
    expect(playbackIndex).toBeGreaterThan(contentIndex);
    expect(creditsIndex).toBeGreaterThan(playbackIndex);
  });

  it("keeps the header reservation rule in the stylesheet", () => {
    expect(css).toContain(".published-application-content { padding-top: 56px; }");
    // 头栏几何（回归基线依据）：fixed 40px 高 + 12px 顶距。
    expect(css).toMatch(/\.published-application-header \{ top: 12px;/);
    expect(css).toMatch(/\.published-application-header \{[^}]*height: 40px;/);
  });
});
