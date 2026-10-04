import type { SceneModelState, UserPrefabDefinition, UserPrefabInstanceRecord, UserPrefabUpdateDiff } from "@bim-studio/contracts";
import type { PrimitiveState } from "@bim-studio/contracts";
import { captureSceneModelState } from "../viewer/captureSceneModelState";
import { captureSceneThumbnail } from "../studio/sceneThumbnailCapture";
import { translate as tr, type AppLocale } from "../i18n";
import type { LoadedSceneModel, ViewerEngine } from "../viewer/ViewerEngine";
import type { ProjectRecord } from "@bim-studio/contracts";
import type { SceneEditHistoryFlush } from "../hooks/useSceneHistoryState";
import {
  captureUserPrefabObjects,
  clearUserPrefabMemberOverrides,
  collectUserPrefabOverrides,
  diffUserPrefabUpdate,
  hasUserPrefabUpdate,
  mergePrototypeWithOverrides,
  planUserPrefabInstance,
  prefabStateAtAnchor,
  type PrefabCapturedObject,
  type UserPrefabObjectState,
} from "../prefabs/userPrefabModel";

type Setter<T> = (value: T) => void;

/** 预制体动作的显式依赖契约；全部经 App 装配注入，便于测试替换。 */
export interface UserPrefabActionsContext {
  engine: ViewerEngine | undefined;
  project: ProjectRecord | undefined;
  locale: AppLocale;
  sceneOrganizationSelection: ReadonlySet<string>;
  userPrefabs: UserPrefabDefinition[];
  userPrefabInstances: UserPrefabInstanceRecord[];
  setUserPrefabs: Setter<UserPrefabDefinition[]>;
  setUserPrefabInstances: Setter<UserPrefabInstanceRecord[]>;
  primitiveColors: { current: Map<string, string> };
  setRevision: (update: (value: number) => number) => void;
  setSceneOrganizationSelection: Setter<Set<string>>;
  setMessage: Setter<string>;
  showError: (reason: unknown) => void;
  /** 与撤销栈同一事务通道；库级变更（存为预制体）不入事务，场景写操作必须入。 */
  sceneHistory: SceneEditHistoryFlush;
  recordSceneEdit: (label: string) => void;
}

/** 场景对象状态的统一读取口径：primitive 走 primitiveState，model 走 captureSceneModelState。 */
export function readUserPrefabSourceState(
  engine: ViewerEngine,
  project: ProjectRecord | undefined,
  objectId: string,
  primitiveColors: { current: Map<string, string> },
): (SceneModelState & Partial<PrimitiveState>) | undefined {
  const item = engine.listModels().find((model) => model.id === objectId);
  if (!item) return undefined;
  if (item.kind === "primitive") return engine.primitiveState(objectId, primitiveColors.current.get(objectId) ?? "#d4a84f");
  const source = project?.models.find((model) => model.id === (item.assetModelId ?? item.id));
  return captureSceneModelState(engine, item, source);
}

/** 预制体系统用户动作（T0 刀 2）：入库 / 实例化 / 原型更新 / 应用更新 / 覆盖。 */
export function createUserPrefabActions(context: UserPrefabActionsContext) {
  const engine = () => context.engine;
  const definitionById = () => new Map(context.userPrefabs.map((definition) => [definition.id, definition]));

  function readState(objectId: string): (SceneModelState & Partial<PrimitiveState>) | undefined {
    const current = engine();
    return current ? readUserPrefabSourceState(current, context.project, objectId, context.primitiveColors) : undefined;
  }

  function captureSelection(): PrefabCapturedObject[] {
    const current = engine();
    if (!current) return [];
    const entries: PrefabCapturedObject[] = [];
    for (const objectId of context.sceneOrganizationSelection) {
      const item = current.listModels().find((model) => model.id === objectId);
      const state = readState(objectId);
      if (!item || !state) continue;
      entries.push({ objectId, name: item.name, kind: item.kind, state });
    }
    return entries;
  }

  /** 功能 1：把当前多选存为预制体（命名/分类/缩略图）。库级变更，保存场景时随快照持久化。 */
  function saveSelectionAsPrefab(name: string, category: string): UserPrefabDefinition | undefined {
    const current = engine();
    if (!current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      context.showError(new Error(tr(context.locale, "预制体名称不能为空", "Prefab name is required")));
      return;
    }
    const objects = captureSelection();
    if (!objects.length) {
      context.showError(new Error(tr(context.locale, "请先在场景中选择要入库的对象", "Select scene objects first")));
      return;
    }
    const now = new Date().toISOString();
    const definition: UserPrefabDefinition = {
      id: `userprefab:${crypto.randomUUID()}`,
      name: trimmed,
      category: category.trim() || tr(context.locale, "未分类", "Uncategorized"),
      version: 1,
      ...(captureSceneThumbnail(current) ? { thumbnail: captureSceneThumbnail(current)! } : {}),
      createdAt: now,
      updatedAt: now,
      objects: captureUserPrefabObjects(objects),
    };
    context.setUserPrefabs([...context.userPrefabs, definition]);
    context.setRevision((value) => value + 1);
    const message = tr(context.locale, `已存为预制体“${definition.name}”（${definition.objects.length} 个对象），可在资源面板插入实例`, `Saved prefab “${definition.name}” (${definition.objects.length} objects); insert instances from the resources panel`);
    context.setMessage(message);
    return definition;
  }

  /** 写入单个成员状态（primitive/model 通用）：结构已有属性走 applyModelState，基色走 setColor。 */
  function applyMemberState(objectId: string, state: SceneModelState & Partial<PrimitiveState>, name?: string) {
    const current = engine();
    if (!current) return;
    if (typeof state.color === "string" && current.listModels().find((model) => model.id === objectId)?.kind === "primitive") {
      current.setColor(objectId, state.color);
      context.primitiveColors.current.set(objectId, state.color);
    }
    const { modelId: _ignoredModelId, ...rest } = state;
    current.applyModelState(objectId, { ...rest, ...(name ? { name } : {}) });
    if (name) current.rename(objectId, name);
  }

  async function createMember(plan: { objectId: string; name: string; kind: "model" | "primitive"; primitiveKind?: PrimitiveState["kind"]; color?: string; state: UserPrefabObjectState }) {
    const current = engine();
    if (!current) throw new Error("场景引擎未就绪");
    if (plan.kind === "primitive") {
      const color = plan.color ?? "#d4a84f";
      current.createPrimitive(plan.objectId, plan.name, plan.primitiveKind ?? "box", color);
      context.primitiveColors.current.set(plan.objectId, color);
    } else {
      const assetModelId = plan.state.assetModelId;
      const asset = context.project?.models.find((model) => model.id === assetModelId);
      if (!asset?.manifest || asset.status !== "ready") {
        throw new Error(tr(context.locale, `成员“${plan.name}”的模型素材尚未就绪，无法实例化`, `Model asset for “${plan.name}” is not ready`));
      }
      await current.loadManifest(asset.manifest, plan.objectId);
    }
    applyMemberState(plan.objectId, { ...(plan.state as SceneModelState & Partial<PrimitiveState>) });
  }

  /** 功能 2：实例化——在当前相机目标点落位，保持原型层级与相对偏移。 */
  async function instantiateUserPrefab(prefabId: string): Promise<UserPrefabInstanceRecord | undefined> {
    const current = engine();
    const definition = definitionById().get(prefabId);
    if (!current || !definition) return;
    const anchor = current.getCameraState().target;
    const transaction = context.sceneHistory.beginTransaction(tr(context.locale, "插入预制体实例", "Insert prefab instance"));
    try {
      const plans = planUserPrefabInstance(definition, anchor);
      for (const plan of plans) {
        await createMember(plan);
      }
      const record: UserPrefabInstanceRecord = {
        instanceId: `prefabinstance:${crypto.randomUUID()}`,
        prefabId: definition.id,
        prefabVersion: definition.version,
        anchor: { ...anchor },
        memberObjectIds: Object.fromEntries(plans.map((plan) => [plan.sourceId, plan.objectId])),
      };
      // 先写 React 状态再提交事务，撤销快照才能捕获实例登记。
      context.setUserPrefabInstances([...context.userPrefabInstances, record]);
      const rootId = plans[0]?.objectId;
      if (rootId) {
        current.select(rootId);
        context.setSceneOrganizationSelection(new Set(plans.map((plan) => plan.objectId)));
        current.focusModel(rootId);
      }
      context.setRevision((value) => value + 1);
      const message = tr(context.locale, `已插入“${definition.name}”实例（${plans.length} 个对象）`, `Inserted “${definition.name}” instance (${plans.length} objects)`);
      context.recordSceneEdit(message);
      transaction.commit(message);
      context.setMessage(message);
      return record;
    } catch (reason) {
      transaction.rollback();
      throw reason;
    }
  }

  /** 功能 3a：更新原型——以某个实例的当前成员重采集，版本 +1；其他实例进入“待更新”。 */
  function updateUserPrefabFromInstance(prefabId: string, instanceId: string): number | undefined {
    const current = engine();
    const definition = definitionById().get(prefabId);
    const instance = context.userPrefabInstances.find((record) => record.instanceId === instanceId);
    if (!current || !definition || !instance) return;
    const entries: PrefabCapturedObject[] = [];
    for (const [sourceId, sceneObjectId] of Object.entries(instance.memberObjectIds)) {
      const state = readState(sceneObjectId);
      const item = current.listModels().find((model) => model.id === sceneObjectId);
      if (!state || !item) continue;
      entries.push({ objectId: sourceId, name: item.name, kind: item.kind, state });
    }
    if (!entries.length) {
      context.showError(new Error(tr(context.locale, "该实例已无可用成员，无法更新原型", "This instance has no members to update from")));
      return;
    }
    const nextVersion = definition.version + 1;
    // 以实例锚点为采集原点：原型升级只携带成员的真实偏移变化，不对其他实例造成整体平移。
    const captureAnchor = instance.anchor;
    context.setUserPrefabs(context.userPrefabs.map((item) => item.id !== prefabId ? item : {
      ...item,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
      ...(captureSceneThumbnail(current) ? { thumbnail: captureSceneThumbnail(current)! } : {}),
      objects: captureUserPrefabObjects(entries, captureAnchor),
    }));
    context.setRevision((value) => value + 1);
    const affected = context.userPrefabInstances.filter((record) => record.prefabId === prefabId && record.instanceId !== instanceId && hasUserPrefabUpdate(record, { ...definition, version: nextVersion })).length;
    const message = tr(context.locale, `原型“${definition.name}”已更新至 v${nextVersion}${affected ? `，${affected} 个实例可应用更新` : ""}`, `Prototype “${definition.name}” updated to v${nextVersion}${affected ? `; ${affected} instance(s) can apply the update` : ""}`);
    context.setMessage(message);
    return nextVersion;
  }

  /** 功能 3b：应用更新 diff 预览（纯读，不落写）。 */
  function diffUserPrefabInstance(instanceId: string): UserPrefabUpdateDiff | undefined {
    const instance = context.userPrefabInstances.find((record) => record.instanceId === instanceId);
    const definition = instance && definitionById().get(instance.prefabId);
    if (!instance || !definition || !hasUserPrefabUpdate(instance, definition)) return undefined;
    return diffUserPrefabUpdate(instance, definition, readState);
  }

  /** 功能 3c：应用更新——未覆盖属性写原型值，新增成员创建，移除成员删除；随后重算覆盖。 */
  async function applyUserPrefabUpdate(instanceId: string): Promise<UserPrefabUpdateDiff | undefined> {
    const current = engine();
    const instance = context.userPrefabInstances.find((record) => record.instanceId === instanceId);
    const definition = instance && definitionById().get(instance.prefabId);
    if (!current || !instance || !definition || !hasUserPrefabUpdate(instance, definition)) return;
    const diff = diffUserPrefabUpdate(instance, definition, readState);
    if (!diff) return;
    const transaction = context.sceneHistory.beginTransaction(tr(context.locale, "应用预制体更新", "Apply prefab update"));
    try {
      const definitionBySource = new Map(definition.objects.map((object) => [object.sourceId, object]));
      // 1) 共同成员：原型值 + 保留覆盖 → 写回（覆盖路径保留实例值）。
      for (const [sourceId, sceneObjectId] of Object.entries(instance.memberObjectIds)) {
        const prototype = definitionBySource.get(sourceId);
        if (!prototype || !readState(sceneObjectId)) continue;
        const merged = mergePrototypeWithOverrides(prototype.state, instance.overrides?.[sceneObjectId]);
        applyMemberState(sceneObjectId, prefabStateAtAnchor(merged, instance.anchor) as SceneModelState & Partial<PrimitiveState>, merged.name);
      }
      // 2) 移除成员：原型删除的删对象，场景已丢的只清映射。
      for (const removed of diff.removed) {
        if (removed.reason === "prototype" && current.listModels().some((model) => model.id === removed.sceneObjectId)) {
          current.removeModel(removed.sceneObjectId);
          context.primitiveColors.current.delete(removed.sceneObjectId);
        }
      }
      // 3) 新增成员。
      const createdPlans = planUserPrefabInstance(
        { ...definition, objects: definition.objects.filter((object) => diff.added.some((added) => added.sourceId === object.sourceId)) },
        instance.anchor,
      );
      for (const plan of createdPlans) {
        await createMember(plan);
      }
      const memberObjectIds = { ...instance.memberObjectIds };
      for (const removed of diff.removed) delete memberObjectIds[removed.sourceId];
      for (const plan of createdPlans) memberObjectIds[plan.sourceId] = plan.objectId;
      // 4) 版本推进 + 覆盖重算（以新原型为基线，成员偏离才记覆盖）。
      const nextInstance: UserPrefabInstanceRecord = {
        ...instance,
        prefabVersion: definition.version,
        memberObjectIds,
        anchor: { ...instance.anchor },
      };
      const overrides = collectUserPrefabOverrides(nextInstance, definition, readState);
      const finalInstance: UserPrefabInstanceRecord = { ...nextInstance, ...(Object.keys(overrides).length ? { overrides } : {}) };
      context.setUserPrefabInstances(context.userPrefabInstances.map((record) => record.instanceId === instanceId ? finalInstance : record));
      context.setRevision((value) => value + 1);
      const summary = tr(context.locale,
        `已应用更新：属性 ${diff.changed.filter((change) => !change.overridden).length} 处、新增 ${diff.added.length} 个、移除 ${diff.removed.length} 个（保留覆盖 ${diff.changed.filter((change) => change.overridden).length} 处）`,
        `Update applied: ${diff.changed.filter((change) => !change.overridden).length} property change(s), ${diff.added.length} added, ${diff.removed.length} removed (${diff.changed.filter((change) => change.overridden).length} override(s) kept)`);
      transaction.commit(summary);
      context.setMessage(summary);
      return diff;
    } catch (reason) {
      transaction.rollback();
      throw reason;
    }
  }

  /** 功能 4a：检测覆盖——成员与原型一致的属性清空，偏离的属性登记为实例覆盖。 */
  function refreshUserPrefabOverrides(instanceId: string): void {
    const instance = context.userPrefabInstances.find((record) => record.instanceId === instanceId);
    const definition = instance && definitionById().get(instance.prefabId);
    if (!instance || !definition) return;
    const overrides = collectUserPrefabOverrides(instance, definition, readState);
    context.setUserPrefabInstances(context.userPrefabInstances.map((record) => record.instanceId === instanceId
      ? { ...record, ...(Object.keys(overrides).length ? { overrides } : {}) }
      : record));
    context.setRevision((value) => value + 1);
    const count = Object.keys(overrides).length;
    context.setMessage(count
      ? tr(context.locale, `检测到 ${count} 个成员存在实例级覆盖（场景树已标出）`, `${count} member(s) have instance overrides (marked in the scene tree)`)
      : tr(context.locale, "所有成员均与原型一致，无覆盖", "All members match the prototype; no overrides"));
  }

  /** 功能 4b：重置成员——清覆盖并写回原型值。 */
  function resetUserPrefabMember(instanceId: string, sceneObjectId: string): void {
    const current = engine();
    const instance = context.userPrefabInstances.find((record) => record.instanceId === instanceId);
    const definition = instance && definitionById().get(instance.prefabId);
    if (!current || !instance || !definition) return;
    const sourceId = Object.keys(instance.memberObjectIds).find((key) => instance.memberObjectIds[key] === sceneObjectId);
    const prototype = definition.objects.find((object) => object.sourceId === sourceId);
    if (!prototype) return;
    const transaction = context.sceneHistory.beginTransaction(tr(context.locale, "重置为原型", "Reset to prototype"));
    try {
      const target = prefabStateAtAnchor(prototype.state, instance.anchor);
      applyMemberState(sceneObjectId, target as SceneModelState & Partial<PrimitiveState>, prototype.name);
      context.setUserPrefabInstances(context.userPrefabInstances.map((record) => record.instanceId === instanceId
        ? clearUserPrefabMemberOverrides(record, sceneObjectId)
        : record));
      context.setRevision((value) => value + 1);
      const message = tr(context.locale, `“${prototype.name}”已重置为原型值`, `“${prototype.name}” reset to prototype values`);
      transaction.commit(message);
      context.setMessage(message);
    } catch (reason) {
      transaction.rollback();
      throw reason;
    }
  }

  /** 删除预制体定义；仍有实例时阻断并给出处理指引。 */
  function deleteUserPrefab(prefabId: string): void {
    const definition = definitionById().get(prefabId);
    if (!definition) return;
    const linked = context.userPrefabInstances.filter((record) => record.prefabId === prefabId).length;
    if (linked) {
      context.showError(new Error(tr(context.locale, `场景中仍有 ${linked} 个该预制体的实例；请先应用/删除实例，或保持预制体以维持链接`, `${linked} instance(s) still reference this prefab; remove them first to keep links consistent`)));
      return;
    }
    context.setUserPrefabs(context.userPrefabs.filter((item) => item.id !== prefabId));
    context.setRevision((value) => value + 1);
    context.setMessage(tr(context.locale, `预制体“${definition.name}”已删除`, `Prefab “${definition.name}” deleted`));
  }

  return {
    saveSelectionAsPrefab,
    instantiateUserPrefab,
    updateUserPrefabFromInstance,
    diffUserPrefabInstance,
    applyUserPrefabUpdate,
    refreshUserPrefabOverrides,
    resetUserPrefabMember,
    deleteUserPrefab,
  };
}

export type UserPrefabActions = ReturnType<typeof createUserPrefabActions>;
