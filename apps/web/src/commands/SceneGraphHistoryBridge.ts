import type { SceneSnapshot } from "@bim-studio/contracts";
import type { SceneTransformFlushResult, SceneTransformGraph } from "@bim-studio/deep-engine/scene";
import { SceneAuthoringHistory, type SceneAuthoringHistoryState } from "../studio/sceneAuthoringHistory";
import { restoreSceneFromSnapshot, ScenePrimitiveOwner, type SceneReopenResult } from "./ScenePrimitiveOwnerPort";
import type { SceneReferenceRegistry } from "./SceneReferenceCleanupPort";

/**
 * H-C7-P3 第四批 撤销栈对齐:graph driver 线事务与宿主 SceneAuthoringHistory(Ctrl+Z 链)的接线。
 *
 * 形态沿浏览器端删除第一批(editorSceneWriteDriver + SceneEditTransaction):
 * - begin 捕获事务前快照 → commit 把事务窗口内全部变更合并为**一条**撤销条目 →
 *   rollback 返回 before 快照交由调用方恢复,窗口关闭且不产生条目;
 * - 条目的逆算子载体 = before/after SceneSnapshot 对:撤销恢复 before、重做恢复 after,
 *   恢复路径复用第三批重开链 restoreSceneFromSnapshot(不建第二套恢复机制)。
 *
 * 作者域 = port 所有权内的图元(primitives)+ 引用容器(selectionSets/rootLayerOrder 及
 * 只读域透传)。相机不进作者栈——相机浏览不是作者编辑(driver 级逆算子仍在 SDK rollback
 * 内恢复 pose),与浏览器 SceneAuthoringHistory 的既定规则一致。
 */

/** 桥所管理的宿主运行时:撤销/重做会整体换装 owner+graph(引用注册表实例保持不变、容器被回写)。 */
export interface SceneGraphAuthoringRuntime {
  readonly owner: ScenePrimitiveOwner;
  readonly graph: SceneTransformGraph<string>;
  readonly references?: SceneReferenceRegistry;
}

/** 事务窗口句柄;形状与浏览器 hooks/useSceneHistoryState 的 SceneEditTransaction 同构。 */
export interface SceneGraphEditTransaction {
  readonly label: string;
  /** 事务开始前已落栈的快照;失败回滚即恢复到它。 */
  readonly before: SceneSnapshot;
  /** 窗口是否仍开启;commit/rollback 后为 false,过期句柄上的重复提交是空操作。 */
  readonly active: boolean;
  /** 提交:窗口内全部变更合并为一条撤销条目(fingerprint 去重由栈负责)。 */
  commit(override?: string): void;
  /** 放弃:返回事务前快照交由调用方应用;窗口关闭且不产生任何撤销条目。 */
  rollback(): SceneSnapshot | undefined;
}

/** 一次撤销/重做的应用结果:换装后的运行时 + 重水合 flush(宿主据此重建空间投影)。 */
export interface SceneGraphHistoryRestoreResult {
  /** 应用(恢复)的快照:undo 为条目 before,redo 为条目 after。 */
  readonly snapshot: SceneSnapshot;
  readonly runtime: SceneGraphAuthoringRuntime;
  readonly flush: SceneTransformFlushResult<string>;
}

export interface SceneGraphHistoryBridgeOptions {
  readonly sceneId: string;
  /** 注入宿主既有撤销栈(与浏览器 Ctrl+Z 同一实现);缺省为本线新建独立栈。 */
  readonly history?: SceneAuthoringHistory;
}

type Listener = () => void;

/**
 * 参考实现:graph 线作者历史桥。driver 保持宿主无关——本桥是宿主侧胶水,
 * 不参与事务执行,只把已提交事务的 port 域变更记进宿主撤销栈、把撤销/重做
 * 快照重水合回运行时。
 */
export class SceneGraphHistoryBridge {
  private readonly history: SceneAuthoringHistory;
  private current: SceneGraphAuthoringRuntime;
  private open: SceneGraphEditTransaction | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(runtime: SceneGraphAuthoringRuntime, private readonly options: SceneGraphHistoryBridgeOptions) {
    if (!options || typeof options !== "object" || !options.sceneId?.trim()) {
      throw new TypeError("Scene graph history bridge requires a sceneId.");
    }
    if (!runtime || !(runtime.owner instanceof ScenePrimitiveOwner) || !runtime.graph) {
      throw new TypeError("Scene graph history bridge requires a primitive owner and a transform graph.");
    }
    this.history = options.history ?? new SceneAuthoringHistory();
    this.current = runtime;
    this.history.reset(this.capture());
  }

  get sceneId(): string { return this.options.sceneId; }

  /** 当前运行时(撤销/重做换装后引用会变;宿主每轮事务前从这里取 owner/graph)。 */
  get runtime(): SceneGraphAuthoringRuntime { return this.current; }

  /** 撤销栈状态(canUndo/canRedo/标签),与浏览器 Ctrl+Z 门控同源。 */
  state(): SceneAuthoringHistoryState { return this.history.getState(); }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 捕获当前事实快照:port 图元 + 引用容器(相机不进作者栈)。 */
  capture(): SceneSnapshot {
    const snapshot = this.current.owner.snapshotScene();
    const references = this.current.references;
    if (references) {
      snapshot.selectionSets = references.state.selectionSets;
      snapshot.rootLayerOrder = references.state.rootLayerOrder;
      if (references.state.assetBindings) snapshot.assetBindings = [...references.state.assetBindings];
      if (references.state.animation) snapshot.animation = structuredClone(references.state.animation);
      if (references.state.simulationEntities) snapshot.simulationEntities = structuredClone([...references.state.simulationEntities]);
    }
    return snapshot;
  }

  /** 开启事务窗口:不嵌套,重入返回当前开启的事务(与浏览器 createSceneEditTransaction 同规)。 */
  begin(label: string): SceneGraphEditTransaction {
    const existing = this.open;
    if (existing) return existing;
    const before = this.capture();
    const bridge = this;
    const transaction: SceneGraphEditTransaction = {
      label,
      before,
      get active() { return bridge.open === transaction; },
      commit(override?: string) {
        if (bridge.open !== transaction) return;
        bridge.open = undefined;
        // 无有效图元/引用变化时 fingerprint 去重不落条目(no-op 编辑不吃撤销)。
        bridge.history.record(bridge.capture(), override ?? label);
        bridge.emit();
      },
      rollback() {
        if (bridge.open !== transaction) return undefined;
        bridge.open = undefined;
        return structuredClone(transaction.before);
      },
    };
    this.open = transaction;
    return transaction;
  }

  /**
   * 一次作者编辑:开启事务窗口 → 执行 → committed 才落一条撤销条目;
   * rolled-back/rejected/failed 或抛错都关闭窗口、不产生条目,并校验 SDK 逆算子
   * 已把图域恢复到 before(指纹背离 fail-closed,不静默续栈)。
   */
  async edit<T extends { readonly status: string }>(label: string, execute: () => Promise<T>): Promise<T> {
    const transaction = this.begin(label);
    try {
      const outcome = await execute();
      if (outcome.status === "committed") transaction.commit();
      else {
        const before = transaction.rollback();
        if (before && authoringFingerprint(this.capture()) !== authoringFingerprint(before)) {
          throw new Error(`Scene state diverged from the transaction snapshot after '${outcome.status}'; history stack halted (fail-closed).`);
        }
      }
      return outcome;
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }

  /** 撤销:弹出栈顶条目并把 before 快照重水合回运行时;空栈返回 undefined。 */
  undo(): SceneGraphHistoryRestoreResult | undefined {
    return this.restoreFrom(() => this.history.undo());
  }

  /** 重做:恢复被撤销条目的 after 快照;空栈返回 undefined。 */
  redo(): SceneGraphHistoryRestoreResult | undefined {
    return this.restoreFrom(() => this.history.redo());
  }

  private restoreFrom(pop: () => SceneSnapshot | undefined): SceneGraphHistoryRestoreResult | undefined {
    if (this.open) throw new Error("An authoring transaction is still open; commit or roll it back before undo/redo (fail-closed).");
    const snapshot = pop();
    if (!snapshot) return undefined;
    const reopened: SceneReopenResult = restoreSceneFromSnapshot({ snapshot: structuredClone(snapshot), sceneId: this.options.sceneId });
    this.current = {
      owner: reopened.owner,
      graph: reopened.graph,
      ...(this.current.references ? { references: this.rewireReferences(reopened.snapshot) } : {}),
    };
    this.emit();
    return { snapshot: reopened.snapshot, runtime: this.current, flush: reopened.flush };
  }

  /** 撤销/重做后把快照引用容器接回既有注册表(实例不变,宿主句柄持续有效)。 */
  private rewireReferences(snapshot: SceneSnapshot): SceneReferenceRegistry {
    const references = this.current.references!;
    references.restoreReferences({
      containers: {
        selectionSets: (snapshot.selectionSets ?? []).map(set => ({ ...set, objectIds: [...set.objectIds] })),
        rootLayerOrder: (snapshot.rootLayerOrder ?? []).map(ref => ({ ...ref })),
        ...(snapshot.assetBindings ? { assetBindings: snapshot.assetBindings.map(binding => ({ ...binding })) } : {}),
        ...(snapshot.animation ? { animation: structuredClone(snapshot.animation) } : {}),
        ...(snapshot.simulationEntities ? { simulationEntities: structuredClone(snapshot.simulationEntities) } : {}),
      },
    });
    return references;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * 回滚一致性指纹:图元按多重集比对(注册表插入序是删除复原的伪影——restorePrimitive
 * 重新插到尾部,不是语义变更),引用容器保持数组序(rootLayerOrder/选择集序是语义)。
 * 归一化步骤对齐 studio/sceneAuthoringHistory 的 sceneFingerprint(剥离非作者字段)。
 */
function authoringFingerprint(snapshot: SceneSnapshot): string {
  return JSON.stringify({
    primitives: snapshot.primitives.map(primitive => JSON.stringify(primitive)).sort(),
    selectionSets: snapshot.selectionSets ?? null,
    rootLayerOrder: snapshot.rootLayerOrder ?? null,
    assetBindings: snapshot.assetBindings ?? null,
    animation: snapshot.animation ?? null,
    simulationEntities: snapshot.simulationEntities ?? null,
  });
}
