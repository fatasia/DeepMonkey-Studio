import type { ComponentRecord } from "../viewer/analysis";
import { diffComponentSets, type ModelDiffReport } from "../viewer/modelDiff";
import type { ModelDiffHighlightTarget, ModelDiffSnapshot } from "../viewer/viewerEngineModelDiff";

// P1 模型版本变更对比·评审层纯逻辑：跨实例身份归一、diff 执行、高亮目标推导与
// 会话内快照存储。不触碰 three.js 与引擎实例，全部可单测。

/** 会话内快照上限：记录数组常驻内存，超出按最早捕获逐出。 */
export const MAX_MODEL_DIFF_SNAPSHOTS = 8;

/**
 * 跨实例对比身份：stableId 由引擎构造成 `${instanceId}:${源内稳定段}`（IFC GlobalId、
 * ElementId 或结构路径）。同一素材加载为多个实例、或两版素材分别上传时实例段不同，
 * 去掉实例前缀才得到可对齐的构件身份。
 */
export function diffIdentityOf(record: ComponentRecord): string {
  const prefix = `${record.modelId}:`;
  return record.stableId.startsWith(prefix) ? record.stableId.slice(prefix.length) : record.stableId;
}

export function runModelDiff(before: ModelDiffSnapshot, after: ModelDiffSnapshot): ModelDiffReport {
  // 实例级元数据不是构件身份数据，跨版本对比前统一清除：
  // - modelName：实例可自由命名（同一素材加载为多实例时不同）；
  // - path：objectPath 以模型根节点名开头，而根节点名=实例名（sourceName），会污染所有记录；
  //   用结构 id（root/…/element:x）做跨版本路径对齐，层级改名仍会以各节点 name 变化呈现；
  // - properties.modelId / properties.layerNodeId：indexModelObject 注入的运行时元数据；
  // - id==="root" 的 name：即实例名本身，不属于构件。
  const normalize = (snapshot: ModelDiffSnapshot) => snapshot.records.map((record) => ({
    ...record,
    stableId: diffIdentityOf(record),
    name: record.id === "root" ? "" : record.name,
    modelName: "",
    path: record.id,
    properties: withoutRuntimeProperties(record.properties),
  }));
  return diffComponentSets(normalize(before), normalize(after));
}

function withoutRuntimeProperties(properties: Record<string, string>): Record<string, string> {
  const output = { ...properties };
  delete output.modelId;
  delete output.layerNodeId;
  return output;
}

/**
 * diff 报告 → 三色高亮目标。新增落在 after 实例、删除落在 before 实例、
 * 修改落在 after 实例（呈现"现在的样子"）；before/after 是同一实例时自然合并。
 */
export function diffHighlightEntries(report: ModelDiffReport): ModelDiffHighlightTarget[] {
  return [
    ...report.added.map((record) => ({ modelId: record.modelId, nodeId: record.id, kind: "added" as const })),
    ...report.removed.map((record) => ({ modelId: record.modelId, nodeId: record.id, kind: "removed" as const })),
    ...report.modified.map((change) => ({ modelId: change.after.modelId, nodeId: change.after.id, kind: "modified" as const })),
  ];
}

export interface ModelDiffSnapshotEntry extends ModelDiffSnapshot {
  id: string;
  label: string;
}

export function snapshotLabel(modelName: string, capturedAt: string): string {
  const time = new Date(capturedAt);
  const clock = Number.isNaN(time.getTime())
    ? capturedAt
    : time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${modelName} · ${clock}`;
}

/** useSyncExternalStore 友好的会话级快照存储：未变更时 getSnapshot 返回同一引用。 */
export function createModelDiffSnapshotStore() {
  let entries: ModelDiffSnapshotEntry[] = [];
  let sequence = 0;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  const mutate = (next: ModelDiffSnapshotEntry[]) => { entries = next; emit(); };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot(): readonly ModelDiffSnapshotEntry[] {
      return entries;
    },
    add(snapshot: ModelDiffSnapshot): ModelDiffSnapshotEntry {
      sequence += 1;
      const entry: ModelDiffSnapshotEntry = {
        ...snapshot,
        id: `diff-snapshot-${sequence}`,
        label: snapshotLabel(snapshot.modelName, snapshot.capturedAt),
      };
      mutate([...entries, entry].slice(-MAX_MODEL_DIFF_SNAPSHOTS));
      return entry;
    },
    remove(id: string): void {
      if (!entries.some((entry) => entry.id === id)) return;
      mutate(entries.filter((entry) => entry.id !== id));
    },
    get(id: string): ModelDiffSnapshotEntry | undefined {
      return entries.find((entry) => entry.id === id);
    },
  };
}

/** 面板共享的会话级单例；关闭面板不丢快照，刷新页面即清空（诚实边界）。 */
export const modelDiffSnapshotStore = createModelDiffSnapshotStore();
