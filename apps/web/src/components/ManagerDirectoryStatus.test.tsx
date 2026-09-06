import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ManagerDirectoryStatus, managerDirectoryIssue } from "./ManagerDirectoryStatus";
import type { ManagerDirectoryController } from "../hooks/useManagerDirectoryController";

const ready = { key: "scope", phase: "ready", hasData: true } as const;
function directory(): ManagerDirectoryController { return { projects: ready, scenes: ready, applications: ready, retry: vi.fn() }; }

describe("manager directory feedback", () => {
  it.each(["projects", "scenes", "applications"] as const)("exposes persistent actionable errors for %s, not a true empty directory", kind => {
    const state = directory(); state[kind] = { key: "scope", phase: "error", hasData: false, httpStatus: 503 };
    const issue = managerDirectoryIssue(state, true)!;
    expect(issue.kind).toBe(kind);
    const html = renderToStaticMarkup(<ManagerDirectoryStatus issue={issue} locale="zh-CN" onRetry={state.retry} />);
    expect(html).toContain('role="alert"'); expect(html).toContain("HTTP 503");
    expect(html).toContain("重新读取"); expect(html).not.toContain("还没有"); expect(html).not.toContain("新建");
    const tree = ManagerDirectoryStatus({ issue, locale: "zh-CN", onRetry: state.retry });
    tree.props.children[0].props.children[2].props.onClick();
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("prioritizes the failed parent over a child whose request has not started", () => {
    const state = directory();
    state.projects = { key: "scope", phase: "error", hasData: false };
    state.scenes = { key: "scope", phase: "loading", hasData: false };
    expect(managerDirectoryIssue(state, true)?.kind).toBe("projects");
  });

  it("provides a static skeleton while loading, with no retry or create action", () => {
    const html = renderToStaticMarkup(<ManagerDirectoryStatus issue={{ kind: "projects", state: { key: "scope", phase: "loading", hasData: false } }} locale="zh-CN" onRetry={vi.fn()} />);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain("manager-directory-skeleton");
    expect(html).not.toContain("<button"); expect(html).not.toContain("新建");
  });

  it("only allows a real empty-project state after the project directory succeeds", () => {
    const state = directory(); state.scenes = { key: "scope", phase: "idle", hasData: false };
    expect(managerDirectoryIssue(state, false)).toBeUndefined();
    expect(managerDirectoryIssue(state, true)?.kind).toBe("scenes");
  });

  it("labels retained data as potentially stale and translates the error without raw exception text", () => {
    const html = renderToStaticMarkup(<ManagerDirectoryStatus issue={{ kind: "applications", state: { key: "scope", phase: "error", hasData: true } }} locale="en-US" onRetry={vi.fn()} />);
    expect(html).toContain("Unable to load the application directory"); expect(html).toContain("may be out of date");
    expect(html).not.toContain("暂时");
  });
});
