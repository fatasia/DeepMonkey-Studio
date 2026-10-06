import type { SceneSnapshot } from "@bim-studio/contracts";

const DEFAULT_HISTORY_LIMIT = 100;

interface SceneHistoryEntry {
  readonly label: string;
  readonly before: SceneSnapshot;
  readonly after: SceneSnapshot;
}

export interface SceneAuthoringHistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel?: string;
  readonly redoLabel?: string;
}

type Listener = () => void;

/**
 * 三维作者历史独立于服务器版本：只记录用户编辑，不把相机浏览和选择状态写入应用命令栈。
 * 快照恢复统一走 applyScene，确保对象、标签、绑定和环境状态同步回到同一时刻。
 */
export class SceneAuthoringHistory {
  private current: SceneSnapshot | undefined;
  private undoStack: SceneHistoryEntry[] = [];
  private redoStack: SceneHistoryEntry[] = [];
  private readonly listeners = new Set<Listener>();
  private mutationRevision = 0;

  constructor(private readonly limit = DEFAULT_HISTORY_LIMIT) {}

  /** Local monotonic CAS token; independent of persisted document revisions. */
  get revision(): number { return this.mutationRevision; }

  /** Rehydration normalizes defaults: adopt its readback without recording an authored edit. */
  acceptRestoredScene(scene: SceneSnapshot, expectedRevision: number): void {
    if (this.mutationRevision !== expectedRevision || !this.current
      || scene.id !== this.current.id || scene.projectId !== this.current.projectId) {
      throw new Error("场景历史版本已前进或所属场景已改变，不能用较旧恢复结果覆盖新编辑，请重试。");
    }
    this.current = cloneScene(scene);
    this.mutationRevision += 1;
  }

  getState(): SceneAuthoringHistoryState {
    const undoEntry = this.undoStack.at(-1);
    const redoEntry = this.redoStack.at(-1);
    return {
      canUndo: Boolean(undoEntry),
      canRedo: Boolean(redoEntry),
      ...(undoEntry ? { undoLabel: undoEntry.label } : {}),
      ...(redoEntry ? { redoLabel: redoEntry.label } : {})
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(scene: SceneSnapshot | undefined): void {
    this.current = scene ? cloneScene(scene) : undefined;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  record(scene: SceneSnapshot, label: string): boolean {
    if (!this.current) {
      this.reset(scene);
      return false;
    }
    if (sceneFingerprint(this.current) === sceneFingerprint(scene)) return false;
    const entry: SceneHistoryEntry = {
      label: label.trim() || "编辑三维场景",
      before: cloneScene(this.current),
      after: cloneScene(scene)
    };
    this.undoStack = [...this.undoStack.slice(-(this.limit - 1)), entry];
    this.redoStack = [];
    this.current = cloneScene(scene);
    this.emit();
    return true;
  }

  /**
   * 恢复尾部收敛对齐：把撤销/重做恢复完成后迟到的引擎收敛（异步挂载/资源就绪等，
   * Deep 下晚于 acceptRestoredScene 到达）吸收进栈当前快照——只推进 current，
   * 不落撤销条目、不清重做栈。与 record 的区别正是这两点：收敛不是用户编辑，
   * 若走 record 会让紧随的重做变成静默空操作（门10 undo/redo 竞态根因）。
   */
  absorb(scene: SceneSnapshot): boolean {
    if (!this.current) return false;
    if (sceneFingerprint(this.current) === sceneFingerprint(scene)) return false;
    this.current = cloneScene(scene);
    this.emit();
    return true;
  }

  /** 首次保存只确定身份，所有草稿历史仍指向同一已保存场景。 */
  adoptSceneIdentity(saved: SceneSnapshot): void {
    if (!this.current || this.current.projectId !== saved.projectId) { this.reset(saved); return; }
    const identify = (scene: SceneSnapshot): SceneSnapshot => ({ ...scene, id: saved.id, projectId: saved.projectId, createdAt: saved.createdAt });
    this.current = identify(this.current);
    this.undoStack = this.undoStack.map(entry => ({ ...entry, before: identify(entry.before), after: identify(entry.after) }));
    this.redoStack = this.redoStack.map(entry => ({ ...entry, before: identify(entry.before), after: identify(entry.after) }));
    this.emit();
  }

  undo(): SceneSnapshot | undefined {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push(entry);
    this.current = cloneScene(entry.before);
    this.emit();
    return cloneScene(entry.before);
  }

  redo(): SceneSnapshot | undefined {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push(entry);
    this.current = cloneScene(entry.after);
    this.emit();
    return cloneScene(entry.after);
  }

  private emit(): void {
    this.mutationRevision += 1;
    for (const listener of this.listeners) listener();
  }
}

function cloneScene(scene: SceneSnapshot): SceneSnapshot {
  return structuredClone(scene);
}

function sceneFingerprint(scene: SceneSnapshot): string {
  const copy = cloneScene(scene);
  // 保存时生成的缩略图、时间戳和当前选择不是作者编辑，不能吃掉一次撤销。
  copy.updatedAt = "";
  // 未保存草稿的快照身份和创建时间会变化，它们不是用户编辑。
  copy.id = "";
  copy.createdAt = "";
  delete copy.thumbnail;
  delete copy.selectedModelId;
  delete copy.selectedLayerId;
  delete copy.selectedAnnotationId;
  return JSON.stringify(copy);
}
