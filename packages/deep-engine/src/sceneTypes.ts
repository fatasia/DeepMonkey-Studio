import type { TransformState } from "./sceneTransform.js";

export type SceneObjectId = string;

export interface SceneObjectSnapshot {
  readonly id: SceneObjectId;
  readonly name: string;
  readonly parent?: SceneObjectId;
  readonly children: readonly SceneObjectId[];
  readonly transform: TransformState;
  readonly visible: boolean;
  readonly materialHandle?: string;
}

export interface SceneStateSnapshot {
  readonly revision: number;
  readonly rootIds: readonly SceneObjectId[];
  readonly objects: Readonly<Record<SceneObjectId, SceneObjectSnapshot>>;
  readonly disposedIds: readonly SceneObjectId[];
}

export interface SceneStateStats {
  readonly objectCount: number;
  readonly rootCount: number;
  readonly disposedCount: number;
  readonly dirtyCount: number;
}
