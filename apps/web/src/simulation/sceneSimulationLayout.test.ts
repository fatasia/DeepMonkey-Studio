import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { constrainDockWidth, decodeSimulationLayout, readSimulationLayout, writeSimulationLayout, DEFAULT_SIMULATION_LAYOUT, LEGACY_SIMULATION_LAYOUT_KEY, SIMULATION_LAYOUT_KEY } from "./sceneSimulationLayout";

afterEach(() => vi.unstubAllGlobals());

describe("simulation workspace layout boundaries", () => {
  it("anchors compact menus across the whole compact range and keeps the dock splitter narrow", async () => {
    const css = await readFile(new URL("../styles/sceneSimulationPanel.css", import.meta.url), "utf8");
    const compact = css.split("@container studio-scene (max-width: 680px)")[1]!.split("@container studio-scene (max-width: 440px)")[0]!;
    expect(compact).toContain(".scene-tool-task { position: static; }");
    expect(compact).toContain(".scene-tool-menu { max-width: 100%; }");
    expect(css).toContain(".studio-scene-surface .view-control { top: 110px; }");
    expect(css).toMatch(/#root \.scene-simulation-panel\.is-docked \.scene-simulation-resize-handle \{[^}]*width: 6px; min-width: 0;/);
  });

  it("migrates a valid v1 floating rectangle without inventing simulation state", () => {
    const floating = { left: 34, top: 78, width: 520, height: 600 };
    expect(decodeSimulationLayout(floating)).toEqual({ ...DEFAULT_SIMULATION_LAYOUT, floating });
  });

  it.each([null, {}, { version: 3 }, { version: 2, placement: "center" }, { left: 0, top: 0, width: -1, height: 200 }])("rejects invalid or unsupported layouts: %j", value => {
    expect(decodeSimulationLayout(value)).toBeUndefined();
  });

  it("normalizes finite geometry and whitelists layout fields", () => {
    expect(decodeSimulationLayout({ version: 2, placement: "right", collapsed: true, dockWidth: 900, seed: "not-layout", study: { id: "private-run" } })).toEqual({ version: 2, placement: "right", collapsed: true, dockWidth: 600 });
  });

  it("leaves at least 280 px of actual viewport space and handles tiny hosts", () => {
    expect(constrainDockWidth(500, 800)).toBe(500);
    expect(constrainDockWidth(500, 700)).toBe(420);
    expect(constrainDockWidth(500, 300)).toBe(20);
    expect(constrainDockWidth(500, 100)).toBe(0);
    expect(constrainDockWidth(100, 1000)).toBe(360);
  });

  it("falls back to valid v1 when v2 JSON is corrupt", () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === SIMULATION_LAYOUT_KEY ? "{" : JSON.stringify({ left: 30, top: 90, width: 480, height: 520 }) });
    expect(readSimulationLayout().floating).toEqual({ left: 30, top: 90, width: 480, height: 520 });
  });

  it("keeps persisted layout separate from close/reopen form or run restoration", () => {
    const storage = { setItem: vi.fn(), getItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    writeSimulationLayout({ ...DEFAULT_SIMULATION_LAYOUT, placement: "left", collapsed: true });
    expect(storage.setItem).toHaveBeenCalledWith(SIMULATION_LAYOUT_KEY, JSON.stringify({ ...DEFAULT_SIMULATION_LAYOUT, placement: "left" }));
    expect(storage.setItem).not.toHaveBeenCalledWith(LEGACY_SIMULATION_LAYOUT_KEY, expect.anything());
  });

  it("survives restricted browser storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(readSimulationLayout()).toEqual(DEFAULT_SIMULATION_LAYOUT);
    expect(() => writeSimulationLayout(DEFAULT_SIMULATION_LAYOUT)).not.toThrow();
  });
});
