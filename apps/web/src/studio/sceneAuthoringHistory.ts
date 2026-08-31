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

  constructor(private readonly limit = DEFAULT_HISTORY_LIMIT) {}

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
    for (const listener of this.listeners) listener();
  }
}

function cloneScene(scene: SceneSnapshot): SceneSnapshot {
  return structuredClone(scene);
}

function sceneFingerprint(scene: SceneSnapshot): string {
  const copy = cloneScene(scene);
  // 时间戳和当前选择不是作者内容，不能制造无意义的撤销步骤。
  copy.updatedAt = "";
  delete copy.selectedModelId;
  delete copy.selectedLayerId;
  delete copy.selectedAnnotationId;
  return JSON.stringify(copy);
}
