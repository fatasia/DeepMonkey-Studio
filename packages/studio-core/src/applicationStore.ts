import type { ApplicationDocument, ApplicationObjectRef } from "@bim-studio/contracts";
import type { StudioCommand } from "./command.js";

export interface ApplicationState {
  readonly document?: ApplicationDocument;
  readonly selection: readonly ApplicationObjectRef[];
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

interface HistoryEntry {
  command: StudioCommand;
  before: ApplicationDocument;
  after: ApplicationDocument;
}

type Listener = () => void;

function immutableClone<T>(value: T): T {
  const clone = structuredClone(value);
  return freezeRecursively(clone);
}

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      freezeRecursively(nestedValue);
    }
    Object.freeze(value);
  }
  return value;
}

export class ApplicationStore {
  private document?: ApplicationDocument;
  private selection: ApplicationObjectRef[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<Listener>();

  constructor(document?: ApplicationDocument) {
    if (document) {
      this.load(document);
    }
  }

  getState(): ApplicationState {
    return Object.freeze({
      ...(this.document ? { document: immutableClone(this.document) } : {}),
      selection: immutableClone(this.selection),
      dirty: this.undoStack.length > 0,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  load(document: ApplicationDocument): void {
    this.document = structuredClone(document);
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  dispatch(command: StudioCommand): void {
    if (!this.document) {
      throw new Error("没有已打开的应用文档");
    }

    const before = structuredClone(this.document);
    const after = command.execute(structuredClone(before));

    this.document = structuredClone(after);
    this.undoStack.push({ command, before, after: structuredClone(after) });
    this.redoStack = [];
    this.emit();
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) {
      return false;
    }

    this.document = structuredClone(entry.before);
    this.redoStack.push(entry);
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) {
      return false;
    }

    this.document = structuredClone(entry.after);
    this.undoStack.push(entry);
    this.emit();
    return true;
  }

  setSelection(selection: readonly ApplicationObjectRef[]): void {
    this.selection = structuredClone([...selection]);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
