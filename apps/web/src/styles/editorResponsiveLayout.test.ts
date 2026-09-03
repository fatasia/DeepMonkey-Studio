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
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-panel-actions button{width:30px;min-width:30px");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-editor-toolbar{flex-wrap:nowrap;align-items:center}");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-editor-toolbar label:first-child{min-width:110px}");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-editor-toolbar .behavior-target-field{min-width:140px}");
    expect(css).toContain(".behavior-workspace-slot.layout-float .behavior-panel.inspector-open .behavior-inspector{position:absolute");
    expect(css).toContain(".behavior-workspace-slot.layout-split{width:min(520px,68vw);flex-basis:min(520px,68vw)}");
  });

  it("keeps fixed-width 3D side-panel mode controls icon-only at every viewport", async () => {
    const css = await readFile(new URL("studioWorkspacePolish.css", stylesRoot), "utf8");
    expect(css).toContain(".app-shell .panel-heading .panel-mode-button > span { display: none; }");
    expect(css).toContain("white-space: nowrap;");
  });
});
