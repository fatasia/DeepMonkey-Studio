import { describe, expect, it } from "vitest";
import type { AgentAutonomySettings } from "@bim-studio/contracts";
import {
  AgentAutonomySettingsError,
  applyGeneralDenyList,
  defaultAgentAutonomySettings,
  mergeAgentAutonomySettingsDraft,
  resolveAgentAutonomySettings,
  resolveDiscoveryMode,
  resolveRunExecutionMode,
} from "./agentAutonomySettings.js";

describe("agentAutonomySettings", () => {
  it("falls back to confirm/curated defaults when nothing is persisted", () => {
    expect(defaultAgentAutonomySettings()).toEqual({ mode: "confirm", generalDevelopment: false });
    expect(resolveAgentAutonomySettings(undefined)).toEqual({ mode: "confirm", generalDevelopment: false });
    expect(resolveAgentAutonomySettings({ getAgentSettings: () => undefined })).toEqual({ mode: "confirm", generalDevelopment: false });
  });

  it("normalizes persisted settings and keeps the authorization lists intact", () => {
    const saved: NonNullable<AgentAutonomySettings> = {
      mode: "autonomous",
      autoApproveToolIds: ["operations.control.apply", "operations.control.apply", " operations.energy.apply "],
      generalDevelopment: true,
      generalDevelopmentDeniedToolIds: ["data.query.draft"],
      updatedAt: "2026-10-03T00:00:00.000Z",
      updatedBy: "admin-1",
    };
    const resolved = resolveAgentAutonomySettings({ getAgentSettings: () => saved });
    expect(resolved.mode).toBe("autonomous");
    expect(resolved.autoApproveToolIds).toEqual(["operations.control.apply", "operations.energy.apply"]);
    expect(resolved.generalDevelopment).toBe(true);
    expect(resolved.generalDevelopmentDeniedToolIds).toEqual(["data.query.draft"]);
    expect(resolved.updatedBy).toBe("admin-1");
    // 持久档被改成未知模式时读回落 confirm（fail-closed，不放大自主面）。
    expect(resolveAgentAutonomySettings({ getAgentSettings: () => ({ ...saved, mode: "yolo" as never }) }).mode).toBe("confirm");
  });

  it("merges drafts fail-closed: unknown fields and invalid values are rejected", () => {
    const current = resolveAgentAutonomySettings(undefined);
    expect(() => mergeAgentAutonomySettingsDraft(current, { secret: "x" } as never)).toThrow(AgentAutonomySettingsError);
    expect(() => mergeAgentAutonomySettingsDraft(current, { mode: "yolo" as never })).toThrow(AgentAutonomySettingsError);
    expect(() => mergeAgentAutonomySettingsDraft(current, { generalDevelopment: "yes" as never })).toThrow(AgentAutonomySettingsError);
    expect(() => mergeAgentAutonomySettingsDraft(current, { autoApproveToolIds: [42] as never })).toThrow(AgentAutonomySettingsError);

    const merged = mergeAgentAutonomySettingsDraft(
      current,
      { mode: "autonomous", autoApproveToolIds: [" operations.control.apply ", "", "operations.control.apply"], generalDevelopment: true },
      "admin-9",
    );
    expect(merged).toMatchObject({
      mode: "autonomous",
      autoApproveToolIds: ["operations.control.apply"],
      generalDevelopment: true,
      updatedBy: "admin-9",
    });
    expect(merged.updatedAt).toBeTruthy();
  });

  it("resolves run-level overrides with the persisted default as fallback", () => {
    const confirm = defaultAgentAutonomySettings();
    const autonomous: AgentAutonomySettings = { ...confirm, mode: "autonomous", generalDevelopment: true };
    expect(resolveRunExecutionMode(undefined, confirm)).toBe("confirm");
    expect(resolveRunExecutionMode(undefined, autonomous)).toBe("autonomous");
    expect(resolveRunExecutionMode("confirm", autonomous)).toBe("confirm");
    expect(() => resolveRunExecutionMode("run-wild", confirm)).toThrow(AgentAutonomySettingsError);
    // general 发现面必须由持久化开关放行；关闭时 fail-closed。
    expect(resolveDiscoveryMode(undefined, confirm)).toBe("curated");
    expect(resolveDiscoveryMode("general", autonomous)).toBe("general");
    expect(() => resolveDiscoveryMode("general", confirm)).toThrow(AgentAutonomySettingsError);
    expect(() => resolveDiscoveryMode("registry", confirm)).toThrow(AgentAutonomySettingsError);
  });

  it("applies the general deny list ahead of registry visibility", () => {
    const settings: AgentAutonomySettings = {
      mode: "confirm",
      generalDevelopment: true,
      generalDevelopmentDeniedToolIds: ["data.query.draft", "operations.control.apply"],
    };
    expect(applyGeneralDenyList(["data.query.draft", "modeling.parametric.draft", "operations.energy.analyze"], settings))
      .toEqual(["modeling.parametric.draft", "operations.energy.analyze"]);
    expect(applyGeneralDenyList(["operations.control.apply"], settings)).toEqual([]);
  });
});
