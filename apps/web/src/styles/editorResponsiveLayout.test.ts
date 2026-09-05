import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesRoot = new URL("./", import.meta.url);

describe("editor responsive layout contracts", () => {
  it("keeps the 2D inspector reachable as a compact overlay", async () => {
    const css = await readFile(new URL("dashboardWorkspacePolish.css", stylesRoot), "utf8");

    expect(css).toContain(".dashboard-workspace:not(.inspector-collapsed) .dashboard-inspector-panel");
    expect(css).toContain("width: min(288px, calc(100vw - 48px))");
    expect(css).toContain(".dashboard-workspace.inspector-collapsed .dashboard-inspector-panel { display: none; }");
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
