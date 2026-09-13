import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesRoot = new URL("./", import.meta.url);

async function readStyleBundle(file: string): Promise<string> {
  const css = await readFile(new URL(file, stylesRoot), "utf8");
  const imports = [...css.matchAll(/@import\s+"([^"]+)";/g)].map(match => match[1]!);
  if (imports.length === 0) return css;
  return (await Promise.all(imports.map(imported => readStyleBundle(imported)))).join("\n");
}

describe("editor responsive layout contracts", () => {
  it("switches data-center columns together with the preview at 1000px", async () => {
    const css = await readFile(new URL("data-center-workbench.css", stylesRoot), "utf8");
    expect(css).toMatch(/@media \(max-width: 1000px\)\s*\{[\s\S]*?\.data-center-page \.data-center-columns\s*\{ grid-template-columns: 1fr 1fr;/);
  });
  it("anchors scene actions to the right in wide and compact headers", async () => {
    const base = await readStyleBundle("scene-workspace.css");
    const actions = base.match(/\.topbar-actions\s*\{([^}]*)\}/)?.[1];
    expect(actions).toContain("flex: 0 1 auto");
    expect(actions).toContain("margin-left: auto");
    const compact = await readFile(new URL("studioWorkspacePolish.css", stylesRoot), "utf8");
    const override = compact.match(/\.app-shell \.topbar-actions\s*\{([^}]*)\}/)?.[1];
    expect(override).toContain("margin-left: auto");
    expect(override).not.toContain("margin-left: 0");
  });

  it("keeps solid primary actions readable across brand changes and hover", async () => {
    for (const file of ["scene-workspace.css", "managerWorkspaceChrome.css", "managerSceneCards.css", "dashboardWorkspacePolish.css"]) {
      const css = await readStyleBundle(file);
      const primary = [...css.matchAll(/[^{}]*button\.primary\b[^{}]*\{([^{}]*)\}/g)].map(match => match[1]!);
      expect(primary.length).toBeGreaterThanOrEqual(2);
      for (const block of primary) expect(block).toContain("color: var(--on-accent)");
    }
  });

  it("derives the shared keyboard focus from the current brand rather than fixed gold", async () => {
    const css = await readFile(new URL("interactionPolish.css", stylesRoot), "utf8");
    expect(css).toContain("outline: 2px solid var(--accent)");
    expect(css).toContain("box-shadow: 0 0 0 3px var(--accent-soft)");
    expect(css).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
  });

  it("keeps the 2D inspector reachable as a compact overlay", async () => {
    const css = await readFile(new URL("dashboardWorkspacePolish.css", stylesRoot), "utf8");

    expect(css).toContain(".dashboard-workspace:not(.inspector-collapsed) .dashboard-inspector-panel");
    expect(css).toContain("width: min(288px, calc(100vw - 48px))");
    expect(css).toContain(".dashboard-workspace.inspector-collapsed .dashboard-inspector-panel { display: none; }");
    expect(css).toContain(".dashboard-workspace:not(.left-panel-collapsed) .dashboard-panel-controls .panel-toggle-right { right: 274px; }");
    expect(css).toMatch(/@media \(max-width: 1180px\)[\s\S]*?\.dashboard-panel-controls \.panel-toggle-right \{ right: 274px; \}/);
  });

  it("keeps the 3D inspector toggle centered on every visible inspector boundary", async () => {
    const base = await readFile(new URL("base.css", stylesRoot), "utf8");
    const responsive = await readFile(new URL("platform-components.css", stylesRoot), "utf8");

    expect(base).toContain(".app-shell.left-panel-collapsed { grid-template-columns: 0 minmax(480px, 1fr) 304px; }");
    expect(base).toContain(".workspace-panel-controls .panel-toggle-right{right:290px}");
    expect(responsive).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.workspace-panel-controls \.panel-toggle-right \{ right: 256px; \}/);
    expect(responsive).toMatch(/@media \(max-width: 850px\)[\s\S]*?\.workspace-panel-controls \.panel-toggle-right \{ right: 6px; \}/);
  });

  it("uses the same field styling and two-column rhythm for all AI model settings", async () => {
    const css = await readFile(new URL("platform-pages.css", stylesRoot), "utf8");

    expect(css).toContain(".system-ai-settings input,.system-ai-settings select");
    expect(css).toContain(".system-ai-3d-settings article { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));");
  });

  it("keeps secondary-page back actions adjacent to their titles", async () => {
    const shared = await readFile(new URL("platform-pages.css", stylesRoot), "utf8");
    const centers = await readFile(new URL("centers.css", stylesRoot), "utf8");

    expect(shared).toContain(".secondary-page-heading-row { display: flex; min-width: 0; align-items: center; justify-content: flex-start;");
    expect(centers).toContain(".operations-header .secondary-page-heading-row { align-items:center;justify-content:flex-start; }");
    expect(centers).toContain(".operations-summary { display:flex;flex-wrap:wrap;gap:7px;margin-left:auto;");
  });

  it("keeps compact script actions, editor controls and settings inside the viewport", async () => {
    const css = await readFile(new URL("centers.css", stylesRoot), "utf8");

    expect(css).toContain(".behavior-editor { display: grid; min-width: 0; min-height: 0; overflow: hidden;");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-panel-actions > .behavior-icon-action{width:30px;min-width:30px");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-editor-toolbar{flex-wrap:nowrap;align-items:center}");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-editor-toolbar label:first-child{min-width:110px}");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-editor-toolbar .behavior-target-field{min-width:140px}");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-panel.inspector-open .behavior-inspector{position:absolute");
    expect(css).toContain(".behavior-workspace-slot.layout-split{width:min(520px,68vw);flex-basis:min(520px,68vw)}");
  });

  it("leaves Monaco in charge of editor themes and removes hidden inspector space in split mode", async () => {
    const css = await readFile(new URL("platform-components.css", stylesRoot), "utf8");
    expect(css).not.toMatch(/\.professional-code-editor \.monaco-editor[^\n]+background-color:[^\n]+!important/);
    const base = await readFile(new URL("base.css", stylesRoot), "utf8");
    expect(base).toContain(".app-workspace-frame.behavior-split.behavior-from-dashboard :is(.dashboard-design-surface,.dashboard-page-bar,.dashboard-field-panel-shell){margin-right:0;max-width:100%}");
  });

  it("keeps fixed-width 3D side-panel mode controls icon-only at every viewport", async () => {
    const css = await readFile(new URL("studioWorkspacePolish.css", stylesRoot), "utf8");
    expect(css).toContain(".app-shell .panel-heading .panel-mode-button > span { display: none; }");
    expect(css).toContain("white-space: nowrap;");
  });
});
