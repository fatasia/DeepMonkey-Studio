import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScenePublicationArtifacts, type ScenePublicationArtifactsProps } from "./ScenePublicationArtifacts";
import type { SceneArtifactRecord } from "../controllers/scenePublicationArtifactRecord";

const harness = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as Array<() => void>, cleanups: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [harness.slots[index], (value: unknown) => { harness.slots[index] = typeof value === "function" ? (value as (old: unknown) => unknown)(harness.slots[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.slots)) harness.slots[index] = { current: initial };
      return harness.slots[index];
    },
    useEffect: (setup: () => void | (() => void), dependencies: unknown[]) => {
      const index = harness.cursor++, previous = harness.slots[index] as unknown[] | undefined;
      if (previous && previous.every((value, i) => Object.is(value, dependencies[i]))) return;
      harness.slots[index] = dependencies;
      harness.effects.push(() => { harness.cleanups[index]?.(); const cleanup = setup(); harness.cleanups[index] = cleanup ?? (() => undefined); });
    },
  };
});

beforeEach(() => { harness.cleanups.forEach((cleanup) => cleanup()); harness.cursor = 0; harness.slots = []; harness.effects = []; harness.cleanups = []; });
function record(status: SceneArtifactRecord["status"], version = 1): SceneArtifactRecord {
  return { schemaVersion: 1, key: `task-${version}`, projectId: "project", sceneId: "scene", publicationVersion: version,
    publishedAt: "2026-09-15T12:00:00Z", snapshotFingerprint: "fingerprint", target: "three-webview", renderer: "webgl", toolbarVisible: true,
    status, attemptId: 1, updatedAt: "2026-09-15T12:00:00Z" };
}
function fixture(records: SceneArtifactRecord[] = []) {
  const artifacts: ScenePublicationArtifactsProps["artifacts"] = {
    records, loading: false, error: undefined, load: vi.fn().mockResolvedValue(records),
    retry: vi.fn().mockResolvedValue({ record: record("ready") }), cancel: vi.fn(), begin: vi.fn(),
  };
  return { artifacts, projectId: "project", sceneId: "scene", locale: "zh-CN" as const };
}
function render(props: ScenePublicationArtifactsProps) {
  harness.cursor = 0;
  const tree = ScenePublicationArtifacts(props);
  harness.effects.splice(0).forEach((effect) => effect());
  return tree;
}
type Node = ReactElement<{ children?: React.ReactNode; onClick?: () => void; "aria-label"?: string }>;
function nodes(tree: React.ReactNode): Node[] {
  return Children.toArray(tree).flatMap((child) => isValidElement(child) ? [child as Node, ...nodes((child as Node).props.children)] : []);
}
function click(tree: React.ReactNode, label: string) {
  const button = nodes(tree).find((node) => node.type === "button" && (node.props["aria-label"]?.startsWith(label) || renderToStaticMarkup(node).includes(label)));
  expect(button, label).toBeDefined(); button!.props.onClick!();
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("publication artifact controls", () => {
  it("loads the selected scene once, filters unrelated records and reloads on navigation", async () => {
    const props = fixture([record("failed"), { ...record("ready", 2), sceneId: "other" }, { ...record("ready", 3), projectId: "other" }]);
    const html = renderToStaticMarkup(render(props)); await flush(); render(props);
    expect(props.artifacts.load).toHaveBeenCalledTimes(1);
    expect(props.artifacts.load).toHaveBeenCalledWith("project", "scene");
    expect(html).toContain("版本 1"); expect(html).not.toContain("版本 2"); expect(html).not.toContain("版本 3");
    render({ ...props, sceneId: "other" }); expect(props.artifacts.load).toHaveBeenCalledWith("project", "other");
  });

  it.each(["failed", "cancelled", "ready"] as const)("executes the original %s record retry and blocks duplicate clicks", async (status) => {
    const source = record(status), props = fixture([source]);
    let release!: () => void;
    vi.mocked(props.artifacts.retry).mockReturnValue(new Promise((resolve) => { release = () => resolve({ record: record("ready") }); }));
    const tree = render(props), label = status === "ready" ? "再次下载" : "重试打包";
    click(tree, label); click(tree, label);
    expect(props.artifacts.retry).toHaveBeenCalledExactlyOnceWith(source);
    expect(renderToStaticMarkup(render(props))).toContain("准备中");
    click(render(props), "取消打包"); expect(props.artifacts.cancel).toHaveBeenCalledWith(source.key);
    release(); await flush();
  });

  it.each(["preparing", "building"] as const)("cancels a %s task", (status) => {
    const source = record(status), props = fixture([source]); click(render(props), "取消打包");
    expect(props.artifacts.cancel).toHaveBeenCalledWith(source.key); expect(props.artifacts.retry).not.toHaveBeenCalled();
  });

  it("shows a rejected load and executes reload", async () => {
    const props = fixture(); vi.mocked(props.artifacts.load).mockRejectedValueOnce(new Error("存储读取失败"));
    render(props); await flush();
    const tree = render(props); expect(renderToStaticMarkup(tree)).toContain("存储读取失败");
    click(tree, "重新读取"); await flush();
    expect(props.artifacts.load).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(render(props))).not.toContain("存储读取失败");
  });

  it("shows real retry errors and ignores a late rejection after navigation", async () => {
    const props = fixture([{ ...record("failed"), error: "缺少资源：pump.glb" }]);
    vi.mocked(props.artifacts.retry).mockRejectedValueOnce(new Error("任务保存失败"));
    click(render(props), "重试打包"); await flush();
    expect(renderToStaticMarkup(render(props))).toContain("任务保存失败");
    expect(renderToStaticMarkup(render(props))).toContain("缺少资源：pump.glb");
    let reject!: (reason: Error) => void;
    vi.mocked(props.artifacts.retry).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    click(render(props), "重试打包"); render({ ...props, sceneId: "other" });
    reject(new Error("迟到错误")); await flush();
    expect(renderToStaticMarkup(render({ ...props, sceneId: "other" }))).not.toContain("迟到错误");
  });

  it("renders loading, English empty state and collapsed older history", () => {
    const props = fixture();
    expect(renderToStaticMarkup(render({ ...props, artifacts: { ...props.artifacts, loading: true } }))).toContain("正在读取");
    expect(renderToStaticMarkup(render({ ...props, locale: "en-US" }))).toContain("Package retries will appear here");
    const tree = render({ ...props, artifacts: { ...props.artifacts, records: [record("ready", 1), record("failed", 2), record("cancelled", 3)] } });
    expect(nodes(tree).filter((node) => node.type === "details")).toHaveLength(1);
    expect(renderToStaticMarkup(tree)).toContain("更多记录（1）");
  });
});
