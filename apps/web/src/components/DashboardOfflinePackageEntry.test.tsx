import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPublicationPointer } from "./dashboardOfflinePackageState";

const harness = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], effects: new Set<number>(),
  application: { metadata: { projectId: "project", id: "application" }, pages: [{ id: "draft-only" }],
    publicationProfiles: [{ entryPageId: "draft-only" }] },
  read: vi.fn(), prepare: vi.fn(), download: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (value: unknown) => harness.cells[harness.cursor++] ??= { current: value },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => { const index = harness.cursor++; if (!harness.effects.has(index)) { harness.effects.add(index); fn(); } },
  useState: (initial: unknown) => {
    const index = harness.cursor++; if (!(index in harness.cells)) harness.cells[index] = initial;
    return [harness.cells[index], (value: unknown) => { harness.cells[index] = value; }];
  },
  useReducer: (reducer: (state: unknown, event: unknown) => unknown, _initial: unknown, init: () => unknown) => {
    const index = harness.cursor++; if (!(index in harness.cells)) harness.cells[index] = init();
    return [harness.cells[index], (event: unknown) => { harness.cells[index] = reducer(harness.cells[index], event); }];
  },
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("../api", () => ({ api: { readActivePublication: harness.read, prepareDashboardCandidate: harness.prepare,
  openDashboardCandidateDownload: harness.download } }));
vi.mock("./dashboardWorkspaceContext", () => ({ useDashboardWorkspace: () => ({ application: harness.application, busy: false, locale: "zh-CN" }) }));
vi.mock("../hooks/useGlobalDialogEscape", () => ({ useDialogEscape: () => undefined }));
import { DashboardOfflinePackageEntry } from "./DashboardOfflinePackageEntry";
type Props = Record<string, unknown> & { children?: ReactNode };
function expand(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!isValidElement<Props>(node)) return [];
  if (typeof node.type === "function") return expand((node.type as (props: Props) => ReactNode)(node.props));
  return [node, ...expand(node.props.children)];
}
function label(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(label).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return isValidElement<Props>(node) ? label(node.props.children) : "";
}
function render() { harness.cursor = 0; return expand(DashboardOfflinePackageEntry()); }
function click(name: string) {
  const button = render().find(node => node.type === "button" && label(node.props.children) === name);
  expect(button, `button: ${name}`).toBeDefined(); (button!.props.onClick as () => void)();
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function publication(): DashboardPublicationPointer {
  return { id: "published-1", projectId: "project", applicationId: "application", applicationRevision: 7, publishedAt: "2026-09-17T00:00:00Z",
    document: { pages: [{ id: "published-home" }], publicationProfiles: [{ entryPageId: "published-home" }] } as NonNullable<DashboardPublicationPointer["document"]> };
}
beforeEach(() => {
  vi.clearAllMocks(); harness.cursor = 0; harness.cells = []; harness.effects.clear();
  harness.application.pages = [{ id: "draft-only" }]; harness.application.publicationProfiles = [{ entryPageId: "draft-only" }];
  harness.read.mockResolvedValue(publication()); harness.prepare.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal("document", { body: {}, activeElement: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("dashboard offline entry publication authority", () => {
  it.each(["changed", "deleted"])("prepares published page even when draft page is %s", async change => {
    if (change === "deleted") { harness.application.pages = []; harness.application.publicationProfiles = []; }
    click("离线包"); render(); await flush(); click("开始准备");
    expect(harness.prepare).toHaveBeenCalledWith("project", "application",
      { publicationId: "published-1", applicationRevision: 7, entryPageId: "published-home" }, expect.any(AbortSignal));
  });
  it("keeps the same published authority on retry and ignores a cancelled late result", async () => {
    let resolve!: (value: unknown) => void;
    harness.prepare.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    click("离线包"); render(); await flush(); click("开始准备");
    const signal = harness.prepare.mock.calls[0]![3] as AbortSignal;
    click("取消"); expect(signal.aborted).toBe(true);
    resolve({ candidateId: "stale" }); await flush();
    expect(render().some(node => node.type === "button" && label(node.props.children) === "下载单文件 EXE")).toBe(false);
    harness.application.publicationProfiles = [{ entryPageId: "later-draft" }];
    click("开始准备"); expect(harness.prepare.mock.calls[1]![2]).toEqual(harness.prepare.mock.calls[0]![2]);
  });
  it("does not replace missing published data with draft pages", async () => {
    harness.read.mockResolvedValue({ ...publication(), document: undefined });
    click("离线包"); render(); await flush();
    expect(render().some(node => node.type === "button" && label(node.props.children) === "开始准备")).toBe(false);
    expect(render().some(node => node.props.role === "alert" && label(node.props.children).includes("发布版本缺少有效入口页"))).toBe(true);
    expect(harness.prepare).not.toHaveBeenCalled();
  });
  it("retries a rejected compilation with the original publication, not newer draft settings", async () => {
    harness.prepare.mockRejectedValueOnce(new Error("compile failed"));
    click("离线包"); render(); await flush(); click("开始准备"); await flush();
    expect(render().some(node => node.props.role === "alert")).toBe(true);
    harness.application.pages = []; harness.application.publicationProfiles = [];
    click("重新准备");
    expect(harness.prepare.mock.calls[1]![2]).toEqual({ publicationId: "published-1", applicationRevision: 7, entryPageId: "published-home" });
  });
  it("does not silently substitute the first page for an invalid published profile", async () => {
    const record = publication(); record.document!.publicationProfiles[0]!.entryPageId = "missing";
    harness.read.mockResolvedValue(record);
    click("离线包"); render(); await flush();
    expect(render().some(node => node.type === "button" && label(node.props.children) === "开始准备")).toBe(false);
    expect(harness.prepare).not.toHaveBeenCalled();
  });
  it("uses the published first page when no publication profile exists", async () => {
    const record = publication(); record.document!.publicationProfiles.length = 0; harness.read.mockResolvedValue(record);
    click("离线包"); render(); await flush(); click("开始准备");
    expect(harness.prepare.mock.calls[0]![2].entryPageId).toBe("published-home");
  });
  it("ignores a late download error body after a newer preparation starts", async () => {
    let finish!: (value: unknown) => void;
    harness.prepare.mockResolvedValueOnce({ candidateId: "first", applicationRevision: 7, objects: [], expiresAt: "2026-09-17T01:00:00Z" });
    harness.download.mockResolvedValue({ ok: false, status: 409, json: () => new Promise(done => { finish = done; }) });
    click("离线包"); render(); await flush(); click("开始准备"); await flush();
    click("下载单文件 EXE"); await flush(); click("重新准备");
    finish({ code: "candidate_expired", message: "old request" }); await flush();
    expect(render().some(node => node.type === "button" && label(node.props.children) === "取消")).toBe(true);
    expect(render().some(node => node.props.role === "alert")).toBe(false);
  });
});
