import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApplicationScriptDependency, ScriptModule } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { ScriptDependencyManager } from "./ScriptDependencyManager.js";
import {
  dependencyImportSnippet,
  findDependencyReferences,
  formatDependencyBytes,
  parseNpmRequest,
  shortIntegrity,
  validateDependencyDraft,
} from "./scriptDependencyManagerModel.js";

const dependency: ApplicationScriptDependency = {
  id: "dep-dayjs",
  specifier: "dayjs",
  source: "npm",
  requested: "dayjs@1.11.13",
  resolvedVersion: "1.11.13",
  fileName: "dayjs-1.11.13.mjs",
  assetUrl: "/api/projects/project-1/script-dependencies/dep-dayjs/content",
  integrity: "sha256-WmFzY2luYXRpbmdIYXNoRm9yVGVzdHNXaXRoNDNCeXRlcz0=",
  size: 12_640,
  license: "MIT",
  installedAt: "2026-09-04T00:00:00.000Z",
};

const script = (code: string): Pick<ScriptModule, "id" | "name" | "code"> => ({ id: "script-1", name: "主控制", code });

describe("ScriptDependencyManager", () => {
  it("renders localized metadata and blocks deletion while a script imports the dependency", () => {
    const html = renderToStaticMarkup(
      <ScriptDependencyManager
        projectId="project-1"
        dependencies={[dependency]}
        scripts={[script('import dayjs from "dayjs";')]}
        activeScriptName="主控制"
        onDependenciesChange={vi.fn()}
        onInsertImport={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(html).toContain("运行内容已本地化");
    expect(html).toContain("npm 锁定 · 1.11.13");
    expect(html).toContain("12 KB");
    expect(html).toContain("1 个脚本");
    expect(html).toContain("被 主控制 引用，不能删除");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-label="关闭项目依赖"');
    expect(html).toContain('title="关闭项目依赖"');
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="搜索项目依赖"');
  });

  it("explains read-only offline mode without hiding installed dependencies", () => {
    const html = renderToStaticMarkup(
      <ScriptDependencyManager
        dependencies={[dependency]}
        scripts={[]}
        installationDisabled
        installationDisabledReason="离线项目仅查看已锁定依赖"
        onDependenciesChange={vi.fn()}
        onInsertImport={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("离线项目仅查看已锁定依赖");
    expect(html).toContain("dayjs");
  });

  it("keeps dependency drawer business text at the 12px readability baseline", () => {
    const css = readFileSync(new URL("./ScriptDependencyManager.css", import.meta.url), "utf8");
    const undersized = [...css.matchAll(/(?:font-size|font)\s*:\s*(\d+(?:\.\d+)?)px/g)]
      .map((match) => Number(match[1]))
      .filter((size) => size > 0 && size < 12);
    expect(undersized).toEqual([]);
  });
});

describe("script dependency model", () => {
  it("finds static, re-export, dynamic and CommonJS references", () => {
    const scripts = [
      script('import * as dayjs from "dayjs";'),
      { id: "script-2", name: "再导出", code: "export { utc } from 'dayjs';" },
      { id: "script-3", name: "动态", code: "const module = await import('dayjs');" },
      { id: "script-4", name: "旧脚本", code: "const module = require(\"dayjs\");" },
      { id: "script-5", name: "无关", code: "studio.log('day');" },
    ];
    expect(findDependencyReferences(scripts, "dayjs").map((item) => item.name)).toEqual(["主控制", "再导出", "动态", "旧脚本"]);
  });

  it("creates a safe namespace import and parses scoped npm requests", () => {
    expect(dependencyImportSnippet("@scope/date-tools")).toBe('import * as dateTools from "@scope/date-tools";\n');
    expect(dependencyImportSnippet("class")).toBe('import * as classModule from "class";\n');
    expect(parseNpmRequest("@scope/date-tools@2.4.1")).toEqual({ packageName: "@scope/date-tools", version: "2.4.1" });
  });

  it("validates exact npm versions, external URLs and upload limits before calling the API", () => {
    expect(validateDependencyDraft({ mode: "npm", specifier: "dayjs", packageName: "dayjs", version: "latest", url: "" })).toContain("固定版本");
    expect(validateDependencyDraft({ mode: "external-url", specifier: "utils", packageName: "", version: "", url: "file:///utils.js" })).toContain("HTTP");
    expect(validateDependencyDraft({ mode: "upload", specifier: "utils", packageName: "", version: "", url: "", file: { name: "utils.js", size: 4 * 1024 * 1024 + 1 } })).toContain("4 MB");
    expect(validateDependencyDraft({ mode: "npm", specifier: "@scope/pkg", packageName: "@scope/pkg", version: "1.2.3-beta.1", url: "" })).toBeUndefined();
  });

  it("formats size and integrity for compact inspection", () => {
    expect(formatDependencyBytes(512)).toBe("512 B");
    expect(formatDependencyBytes(12_640)).toBe("12 KB");
    expect(shortIntegrity(dependency.integrity)).toMatch(/^sha256-.+…/);
  });
});
