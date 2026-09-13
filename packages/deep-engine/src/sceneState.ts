import {
  defaultTransform,
  freezeTransform,
  type TransformPatch,
  type TransformState,
} from "./sceneTransform.js";

import type { SceneObjectId, SceneObjectSnapshot, SceneStateSnapshot, SceneStateStats } from "./sceneTypes.js";
import { assertValidSceneId, DeepSceneStateError } from "./sceneValidation.js";
export type { SceneObjectId, SceneObjectSnapshot, SceneStateSnapshot, SceneStateStats } from "./sceneTypes.js";
export { DeepSceneStateError } from "./sceneValidation.js";

interface InternalSceneObject {
  id: SceneObjectId;
  name: string;
  parent?: SceneObjectId;
  children: SceneObjectId[];
  transform: TransformState;
  visible: boolean;
  materialHandle?: string;
}

export class DeepSceneState {
  private readonly objects = new Map<SceneObjectId, InternalSceneObject>();
  private readonly rootIds: SceneObjectId[] = [];
  private readonly disposedIds = new Set<SceneObjectId>();
  private readonly dirtyIds = new Set<SceneObjectId>();
  private nextGeneratedId = 0;
  private stateRevision = 0;

  createObject(options: {
    id?: SceneObjectId;
    name?: string;
    parent?: SceneObjectId;
    visible?: boolean;
    materialHandle?: string;
    transform?: TransformPatch;
  } = {}): SceneObjectId {
    let generatedId = this.nextGeneratedId;
    let id = options.id;
    if (id === undefined) {
      do { id = `object-${++generatedId}`; }
      while (this.objects.has(id) || this.disposedIds.has(id));
    }
    assertValidSceneId(id);
    if (this.objects.has(id) || this.disposedIds.has(id)) {
      throw new DeepSceneStateError("invalid-id", `Scene object already exists: ${id}.`);
    }
    if (options.materialHandle !== undefined && options.materialHandle.length === 0) {
      throw new DeepSceneStateError("invalid-material", "Material handle cannot be empty.");
    }

    // 所有可能失败的校验先完成，避免创建失败后留下幽灵对象。
    const parent = options.parent === undefined ? undefined : this.requireObject(options.parent);
    const transform = freezeTransform({ ...defaultTransform, ...options.transform });
    this.objects.set(id, {
      id,
      name: options.name ?? id,
      children: [],
      transform,
      visible: options.visible ?? true,
      ...(parent === undefined ? {} : { parent: parent.id }),
      ...(options.materialHandle === undefined ? {} : { materialHandle: options.materialHandle }),
    });
    (parent?.children ?? this.rootIds).push(id);
    this.nextGeneratedId = generatedId;
    this.markDirty(id);
    this.stateRevision += 1;
    return id;
  }

  attach(childId: SceneObjectId, parentId: SceneObjectId, index?: number): void {
    const child = this.requireObject(childId);
    const parent = this.requireObject(parentId);
    if (childId === parentId || this.isDescendant(parentId, childId)) {
      throw new DeepSceneStateError(
        "invalid-parent",
        `Cannot attach ${childId} under its descendant ${parentId}.`,
      );
    }
    const siblings = this.childrenOf(parentId);
    const existingIndex = siblings.indexOf(childId);
    if (existingIndex >= 0) siblings.splice(existingIndex, 1);
    if (index === undefined) {
      siblings.push(childId);
    } else {
      if (!Number.isInteger(index) || index < 0 || index > siblings.length) {
        throw new DeepSceneStateError("invalid-index", `Child index out of range: ${index}.`);
      }
      siblings.splice(index, 0, childId);
    }

    if (child.parent !== undefined) this.markDirty(child.parent);
    this.detachFromCurrentParent(child);
    child.parent = parentId;
    parent.children = siblings;
    this.markSubtreeDirty(childId);
    this.stateRevision += 1;
  }

  detach(childId: SceneObjectId): boolean {
    const child = this.requireObject(childId);
    if (child.parent === undefined) return false;
    this.markDirty(child.parent);
    this.detachFromCurrentParent(child);
    delete child.parent;
    this.rootIds.push(childId);
    this.markSubtreeDirty(childId);
    this.stateRevision += 1;
    return true;
  }

  remove(childId: SceneObjectId, options: { dispose?: boolean } = {}): readonly SceneObjectId[] {
    const removed = this.collectSubtree(childId);
    if (removed.length === 0) {
      throw new DeepSceneStateError("missing-object", `Scene object does not exist: ${childId}.`);
    }
    const target = this.requireObject(childId);
    if (target.parent !== undefined) this.markDirty(target.parent);
    this.detachFromCurrentParent(target);
    for (const id of removed) {
      this.objects.delete(id);
      this.dirtyIds.delete(id);
      if (options.dispose) this.disposedIds.add(id);
    }
    for (const id of removed) this.markDirty(id);
    this.stateRevision += 1;
    return removed;
  }

  setTransform(id: SceneObjectId, patch: TransformPatch): void {
    const object = this.requireObject(id);
    object.transform = freezeTransform({ ...object.transform, ...patch });
    this.markSubtreeDirty(id);
    this.stateRevision += 1;
  }

  setVisible(id: SceneObjectId, visible: boolean): void {
    const object = this.requireObject(id);
    object.visible = visible;
    this.markSubtreeDirty(id);
    this.stateRevision += 1;
  }

  setMaterialHandle(id: SceneObjectId, materialHandle: string): void {
    if (materialHandle.length === 0) {
      throw new DeepSceneStateError("invalid-material", "Material handle cannot be empty.");
    }
    const object = this.requireObject(id);
    object.materialHandle = materialHandle;
    this.markDirty(id);
    this.stateRevision += 1;
  }

  isDirty(id: SceneObjectId): boolean {
    return this.dirtyIds.has(id);
  }

  clearDirty(ids: Iterable<SceneObjectId>): void {
    for (const id of ids) {
      this.dirtyIds.delete(id);
    }
  }

  effectiveVisible(id: SceneObjectId): boolean {
    let current: InternalSceneObject | undefined = this.requireObject(id);
    while (current) {
      if (!current.visible) return false;
      current = current.parent === undefined ? undefined : this.requireObject(current.parent);
    }
    return true;
  }

  traverse(
    visitor: (id: SceneObjectId, object: SceneObjectSnapshot) => void,
    rootId?: SceneObjectId,
  ): void {
    // 先冻结访问顺序；回调中新建节点留到下一轮，删除节点直接跳过。
    const ids = rootId === undefined
      ? this.rootIds.flatMap((id) => this.collectSubtree(id))
      : this.collectSubtree(this.requireObject(rootId).id);
    for (const id of ids) {
      const object = this.objects.get(id);
      if (object) visitor(id, this.toObjectSnapshot(object));
    }
  }

  snapshot(): SceneStateSnapshot {
    const objects: Record<SceneObjectId, SceneObjectSnapshot> = {};
    for (const object of this.objects.values()) {
      objects[object.id] = this.toObjectSnapshot(object);
    }
    return Object.freeze({
      revision: this.stateRevision,
      rootIds: Object.freeze([...this.rootIds]),
      objects: Object.freeze(objects),
      disposedIds: Object.freeze([...this.disposedIds]),
    });
  }

  get stats(): SceneStateStats {
    return Object.freeze({
      objectCount: this.objects.size,
      rootCount: this.rootIds.length,
      disposedCount: this.disposedIds.size,
      dirtyCount: this.dirtyIds.size,
    });
  }

  private requireObject(id: SceneObjectId): InternalSceneObject {
    const object = this.objects.get(id);
    if (!object) {
      throw new DeepSceneStateError("missing-object", `Scene object does not exist: ${id}.`);
    }
    return object;
  }

  private childrenOf(parentId: SceneObjectId): SceneObjectId[] {
    return [...this.requireObject(parentId).children];
  }

  private detachFromCurrentParent(child: InternalSceneObject): void {
    if (child.parent === undefined) {
      const rootIndex = this.rootIds.indexOf(child.id);
      if (rootIndex >= 0) this.rootIds.splice(rootIndex, 1);
      return;
    }
    const parent = this.requireObject(child.parent);
    const index = parent.children.indexOf(child.id);
    if (index >= 0) parent.children.splice(index, 1);
  }

  private isDescendant(candidateId: SceneObjectId, ancestorId: SceneObjectId): boolean {
    let current: InternalSceneObject | undefined = this.requireObject(candidateId);
    while (current?.parent) {
      if (current.parent === ancestorId) return true;
      current = this.objects.get(current.parent);
    }
    return false;
  }

  private collectSubtree(id: SceneObjectId): SceneObjectId[] {
    const result: SceneObjectId[] = [];
    const pending = this.objects.has(id) ? [id] : [];
    while (pending.length > 0) {
      const current = pending.pop()!;
      result.push(current);
      const children = this.requireObject(current).children;
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!);
    }
    return result;
  }

  private markSubtreeDirty(id: SceneObjectId): void {
    for (const child of this.collectSubtree(id)) this.dirtyIds.add(child);
    this.markDirty(id);
  }

  private markDirty(id: SceneObjectId): void {
    this.dirtyIds.add(id);
    let parent = this.objects.get(id)?.parent;
    while (parent) {
      this.dirtyIds.add(parent);
      parent = this.objects.get(parent)?.parent;
    }
  }

  private toObjectSnapshot(object: InternalSceneObject): SceneObjectSnapshot {
    return Object.freeze({
      id: object.id,
      name: object.name,
      ...(object.parent === undefined ? {} : { parent: object.parent }),
      children: Object.freeze([...object.children]),
      transform: object.transform,
      visible: object.visible,
      ...(object.materialHandle === undefined ? {} : { materialHandle: object.materialHandle }),
    });
  }
}
