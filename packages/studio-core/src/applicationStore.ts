import type { ApplicationDocument, ApplicationObjectRef, JsonValue } from "@bim-studio/contracts";
import { applyStudioCommand, type StudioCommand } from "./command.js";
import {
  evaluateApplicationInteraction,
  sameObjectRef,
  type ApplicationInteractionEvent,
  type ApplicationInteractionResult
} from "./interactionRuntime.js";

export interface ApplicationState {
  readonly document?: ApplicationDocument;
  readonly selection: readonly ApplicationObjectRef[];
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly filters: Readonly<Record<string, JsonValue>>;
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
  private variables: Record<string, JsonValue> = {};
  private filters: Record<string, JsonValue> = {};
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private savedFingerprint = "";
  private listeners = new Set<Listener>();
  private stateSnapshot: ApplicationState | undefined;

  constructor(document?: ApplicationDocument) {
    if (document) {
      this.load(document);
    }
  }

  getState(): ApplicationState {
    this.stateSnapshot ??= Object.freeze({
      ...(this.document ? { document: this.document } : {}),
      selection: immutableClone(this.selection),
      variables: immutableClone(this.variables),
      filters: immutableClone(this.filters),
      dirty: this.document ? documentFingerprint(this.document) !== this.savedFingerprint : false,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0
    });
    return this.stateSnapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  load(document: ApplicationDocument): void {
    this.document = immutableClone(document);
    this.savedFingerprint = documentFingerprint(document);
    this.selection = [];
    this.variables = Object.fromEntries(document.data.variables.map((variable) => [variable.id, structuredClone(variable.value)]));
    this.filters = {};
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /** Accept a saved revision without resetting selection, variables or history. */
  acknowledgeSave(saved: ApplicationDocument): void {
    if (!this.document) {
      this.load(saved);
      return;
    }
    const savedFingerprint = documentFingerprint(saved);
    const withServerMetadata = (document: ApplicationDocument): ApplicationDocument => immutableClone({
      ...document,
      metadata: {
        ...document.metadata,
        id: saved.metadata.id,
        projectId: saved.metadata.projectId,
        revision: saved.metadata.revision,
        createdAt: saved.metadata.createdAt,
        updatedAt: saved.metadata.updatedAt
      }
    });
    this.document = documentFingerprint(this.document) === savedFingerprint
      ? immutableClone(saved)
      : withServerMetadata(this.document);
    this.undoStack = this.undoStack.map((entry) => ({ ...entry, before: withServerMetadata(entry.before), after: withServerMetadata(entry.after) }));
    this.redoStack = this.redoStack.map((entry) => ({ ...entry, before: withServerMetadata(entry.before), after: withServerMetadata(entry.after) }));
    this.savedFingerprint = savedFingerprint;
    this.emit();
  }

  dispatch(command: StudioCommand): void {
    if (!this.document) {
      throw new Error("没有已打开的应用文档");
    }

    const before = this.document;
    const after = immutableClone(applyStudioCommand(before, command));

    this.document = after;
    this.undoStack.push({ command, before, after });
    this.redoStack = [];
    this.emit();
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) {
      return false;
    }

    this.document = entry.before;
    this.redoStack.push(entry);
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) {
      return false;
    }

    this.document = entry.after;
    this.undoStack.push(entry);
    this.emit();
    return true;
  }

  setSelection(selection: readonly ApplicationObjectRef[]): void {
    if (sameSelection(this.selection, selection)) return;
    this.selection = structuredClone([...selection]);
    this.emit();
  }

  setVariable(id: string, value: JsonValue): void {
    this.variables[id] = structuredClone(value);
    this.emit();
  }

  setFilter(id: string, value: JsonValue | undefined): void {
    if (value === undefined) delete this.filters[id];
    else this.filters[id] = structuredClone(value);
    this.emit();
  }

  dispatchInteraction(event: ApplicationInteractionEvent): ApplicationInteractionResult {
    if (!this.document) throw new Error("没有已打开的应用文档");
    const result = evaluateApplicationInteraction(this.document, event);
    const selectionChanged = Boolean(result.selection && !sameSelection(this.selection, result.selection));
    if (selectionChanged && result.selection) this.selection = structuredClone([...result.selection]);
    for (const [id, value] of Object.entries(result.variableUpdates)) this.variables[id] = structuredClone(value);
    if (selectionChanged || Object.keys(result.variableUpdates).length > 0) this.emit();
    return immutableClone(result);
  }

  private emit(): void {
    this.stateSnapshot = undefined;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function documentFingerprint(document: ApplicationDocument): string {
  return JSON.stringify({ ...document, metadata: { ...document.metadata, revision: 0, updatedAt: "" } });
}

function sameSelection(left: readonly ApplicationObjectRef[], right: readonly ApplicationObjectRef[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index];
    return Boolean(candidate && sameObjectRef(item, candidate));
  });
}
