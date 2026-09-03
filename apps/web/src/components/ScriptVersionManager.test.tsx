import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScriptModule } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { ScriptVersionManager } from "./ScriptVersionManager";
import {
  diffScriptSnapshots,
  hasScriptSnapshotChanges,
  resolveEscapeAction,
  resolveFocusTrapIndex,
  validateCommitMessage,
  validateRemoteDraft,
} from "./scriptVersionManagerModel";

function script(id: string, name = id, code = "export function onStart() {}") : ScriptModule {
  return {
    id, name, code, enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox",
    lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.read"],
  };
}

describe("ScriptVersionManager", () => {
  it("exposes an accessible dialog and an honest local-workspace fallback", () => {
    const html = renderToStaticMarkup(<ScriptVersionManager
      locale="zh-CN"
      projectId="project-1"
      scripts={[script("controller", "产线控制")]}
      unavailableReason="当前为本地工作区；脚本 Git 需要系统 Git 服务，请切换到服务器模式后使用。"
      onReplaceScripts={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="script-version-title"');
    expect(html).toContain('aria-label="关闭脚本版本"');
    expect(html).toContain("脚本 Git 需要系统 Git 服务");
    expect(html).not.toContain("提交快照");
  });

  it("keeps business typography readable and the drawer responsive", () => {
    const css = readFileSync(new URL("./ScriptVersionManager.css", import.meta.url), "utf8");
    const undersized = [...css.matchAll(/(?:font-size|font)\s*:\s*(\d+(?:\.\d+)?)px/g)]
      .map((match) => Number(match[1]))
      .filter((size) => size > 0 && size < 12);
    expect(undersized).toEqual([]);
    expect(css).toContain("@media (max-width: 700px)");
    expect(css).toContain(".script-version-manager { width: 100%; }");
    expect(css).toContain("grid-template-columns: 1fr;");
  });

  it("keeps Escape and keyboard focus inside the active confirmation", () => {
    expect(resolveEscapeAction(true, false)).toBe("cancel-pull");
    expect(resolveEscapeAction(false, false)).toBe("close");
    expect(resolveEscapeAction(true, true)).toBe("none");
    expect(resolveFocusTrapIndex(3, 0, true)).toBe(2);
    expect(resolveFocusTrapIndex(3, 2, false)).toBe(0);
    expect(resolveFocusTrapIndex(3, 1, false)).toBeUndefined();
    const source = readFileSync(new URL("./ScriptVersionManager.tsx", import.meta.url), "utf8");
    expect(source).toContain("previousFocus?.focus()");
    expect(source).toContain('role="alertdialog"');
  });
});

describe("script version model", () => {
  it("computes an explicit whole-snapshot replacement summary", () => {
    const unchanged = script("same", "相同");
    const diff = diffScriptSnapshots(
      [unchanged, script("updated", "旧名称"), script("removed", "待删除")],
      [unchanged, script("updated", "新名称"), script("added", "新增")],
    );
    expect(diff.added.map((item) => item.id)).toEqual(["added"]);
    expect(diff.updated.map((item) => item.id)).toEqual(["updated"]);
    expect(diff.removed.map((item) => item.id)).toEqual(["removed"]);
    expect(diff.unchanged.map((item) => item.id)).toEqual(["same"]);
    expect(hasScriptSnapshotChanges(diff)).toBe(true);
  });

  it("validates commit messages and credential-free remotes before requests", () => {
    expect(validateCommitMessage(" ")).toContain("修改说明");
    expect(validateCommitMessage("一行\n二行")).toContain("一行");
    expect(validateCommitMessage("完善设备联动")).toBeUndefined();
    expect(validateRemoteDraft("https://user:secret@example.com/team/scripts.git", "main")).toContain("不含凭据");
    expect(validateRemoteDraft("git@example.com:team/scripts.git", "release/v1")).toBeUndefined();
    expect(validateRemoteDraft("https://example.com/team/scripts.git", "../main")).toContain("分支");
  });
});
