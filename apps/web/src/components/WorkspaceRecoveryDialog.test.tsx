import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createWorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";
import { WorkspaceRecoveryDialog } from "./WorkspaceRecoveryDialog";

const scene: SceneSnapshot = {
  schemaVersion: 1, id: "scene-1", projectId: "project-1", name: "装配线",
  camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  models: [], primitives: [], measurements: [], createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z"
};

describe("WorkspaceRecoveryDialog", () => {
  it("offers explicit restore, export, and discard actions", () => {
    const html = renderToStaticMarkup(<WorkspaceRecoveryDialog locale="zh-CN" draft={createWorkspaceRecoveryDraft("project-1", undefined, scene)} serverRevision={8} busy={false} onRestore={vi.fn()} onExport={vi.fn()} onDiscard={vi.fn()} />);
    expect(html).toContain("发现未完成的本地修改");
    expect(html).toContain("恢复到当前页");
    expect(html).toContain("导出副本");
    expect(html).toContain("丢弃副本");
  });
});
