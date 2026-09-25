import * as THREE from "three";
import type { ModelTransform, SceneLayerState } from "@bim-studio/contracts";
import { flattenProperties } from "./bimMetadata";
import { setTreeLock, setTreeVisibility } from "./fragmentTree";
import { applyTransform, objectTransform } from "./sceneObjectUtils";
import { countObjects } from "./viewerStateUtils";
import { type LayerTreeNode } from "./viewerTypes";
import { ViewerEngineBim } from "./viewerEngineBim";

/** Objects 职责层。 */
export abstract class ViewerEngineObjects extends ViewerEngineBim {
  getSelectedLayerId(): string | undefined {
      return this.selectedFragmentNodeId ?? this.inspectedObject?.userData.layerNodeId as string | undefined;
    }
  isModelLocked(modelId: string): boolean {
      return Boolean(this.models.get(modelId)?.object.userData.modelLocked);
    }
  setModelLocked(modelId: string, locked: boolean): void {
      const model = this.models.get(modelId);
      if (!model) return;
      model.object.userData.modelLocked = locked;
      if (this.selectedId === modelId) this.updateTransformAccess();
      this.onModelChange?.(model);
    }
  isLayerLocked(modelId: string, nodeId: string): boolean {
      if (this.isModelLocked(modelId)) return true;
      if (nodeId === "root") return false;
      const fragmentEntry = this.fragmentLayers.get(modelId)?.get(nodeId);
      if (fragmentEntry) return fragmentEntry.node.locked;
      const object = this.layerObjects.get(modelId)?.get(nodeId);
      if (!object) return false;
      let current: THREE.Object3D | null = object;
      while (current) {
        if (current.userData.layerLocked) return true;
        if (current === this.models.get(modelId)?.object) break;
        current = current.parent;
      }
      return false;
    }
  setLayerLocked(modelId: string, nodeId: string, locked: boolean): void {
      if (nodeId === "root") {
        this.setModelLocked(modelId, locked);
        return;
      }
      const model = this.models.get(modelId);
      if (!model) return;
      const fragmentEntry = this.fragmentLayers.get(modelId)?.get(nodeId);
      if (fragmentEntry) setTreeLock(fragmentEntry.node, locked);
      const object = this.layerObjects.get(modelId)?.get(nodeId);
      if (object) object.userData.layerLocked = locked;
      this.updateLayerState(modelId, nodeId, { locked });
      if (this.selectedId === modelId) this.updateTransformAccess();
      this.onModelChange?.(model);
    }
  isSelectionLocked(): boolean {
      const selected = this.getSelected();
      if (!selected) return false;
      return this.isLayerLocked(selected.id, this.getSelectedLayerId() ?? "root");
    }
  getSelectionName(): string {
      const selected = this.getSelected();
      const fragmentEntry = selected && this.selectedFragmentNodeId
        ? this.fragmentLayers.get(selected.id)?.get(this.selectedFragmentNodeId)
        : undefined;
      if (fragmentEntry) return fragmentEntry.node.name;
      return this.inspectedObject?.name || selected?.name || "";
    }
  getSelectionVisible(): boolean {
      const selected = this.getSelected();
      const fragmentEntry = selected && this.selectedFragmentNodeId
        ? this.fragmentLayers.get(selected.id)?.get(this.selectedFragmentNodeId)
        : undefined;
      if (fragmentEntry) return fragmentEntry.node.visible;
      return this.inspectedObject?.visible ?? this.getSelected()?.visible ?? false;
    }
  getSelectionOpacity(): number {
      const selected = this.getSelected();
      if (!selected) return 1;
      if (this.selectedFragmentNodeId) {
        return this.layerStates.get(selected.id)?.get(this.selectedFragmentNodeId)?.opacity ?? 1;
      }
      if (!this.inspectedObject || this.inspectedObject === selected.object) return selected.opacity;
      let opacity: number | undefined;
      this.inspectedObject.traverse((child) => {
        if (opacity !== undefined) return;
        const mesh = child as THREE.Mesh;
        const material = this.materialsForMesh(mesh)[0];
        if (material) opacity = material.opacity;
      });
      return opacity ?? 1;
    }
  getSelectionColor(): string {
      const selected = this.getSelected();
      if (selected && this.selectedFragmentNodeId) {
        return this.layerStates.get(selected.id)?.get(this.selectedFragmentNodeId)?.color ?? "#2684ff";
      }
      return this.objectColor(this.inspectedObject);
    }
  getModelColor(id: string): string {
      return this.objectColor(this.models.get(id)?.object);
    }
  getModelColorOverride(id: string): string | undefined {
      return this.modelColorOverrides.get(id);
    }
  setSelectionColor(color: string): void {
      const model = this.getSelected();
      const object = this.inspectedObject;
      if (!model) return;
      if (this.selectedFragmentNodeId) {
        const entry = this.fragmentLayers.get(model.id)?.get(this.selectedFragmentNodeId);
        const fragmentModel = this.fragmentModels.get(model.id);
        if (!entry || !fragmentModel) return;
        void fragmentModel.setColor(entry.localIds, new THREE.Color(color));
        this.updateLayerState(model.id, this.selectedFragmentNodeId, { color });
        this.onModelChange?.(model);
        return;
      }
      if (!object) return;
      const wholeFragmentModel = this.fragmentModels.get(model.id);
      const wholeFragmentEntry = this.fragmentLayers.get(model.id)?.get("root");
      if (object === model.object && wholeFragmentModel && wholeFragmentEntry) {
        void wholeFragmentModel.setColor(wholeFragmentEntry.localIds, new THREE.Color(color));
        this.modelColorOverrides.set(model.id, color);
        this.onModelChange?.(model);
        return;
      }
      this.setObjectColor(object, color);
      if (object === model.object) this.modelColorOverrides.set(model.id, color);
      else this.updateLayerState(model.id, String(object.userData.layerNodeId), { color });
      this.onModelChange?.(model);
    }
  getSelectionProperties(): Record<string, string> {
      const selected = this.getSelected();
      if (!selected) return {};
      if (this.selectedFragmentNodeId) {
        const entry = this.fragmentLayers.get(selected.id)?.get(this.selectedFragmentNodeId);
        if (entry) return { ...entry.properties, 名称: entry.node.name, 类型: entry.node.type, 构件数量: String(entry.localIds.length) };
      }
      const properties: Record<string, string> = {
        名称: this.inspectedObject?.name || selected.name,
        类型: this.inspectedObject?.type || selected.object.type,
        对象数量: String(countObjects(selected.object))
      };
      let current: THREE.Object3D | null = this.inspectedObject ?? selected.object;
      while (current) {
        flattenProperties(current.userData, properties);
        if (current === selected.object) break;
        current = current.parent;
      }
      return properties;
    }
  getLayerTree(modelId: string): LayerTreeNode | undefined {
      const fragmentTree = this.fragmentTrees.get(modelId);
      if (fragmentTree) {
        const snapshot = structuredClone(fragmentTree);
        if (this.isModelLocked(modelId)) setTreeLock(snapshot, true);
        return snapshot;
      }
      const model = this.models.get(modelId);
      const objects = this.layerObjects.get(modelId);
      if (!model || !objects) return undefined;
      const build = (object: THREE.Object3D, ancestorLocked = false): LayerTreeNode => ({
        id: String(object.userData.layerNodeId),
        modelId,
        name: object.name || object.userData.layer || object.type,
        type: object.type,
        visible: object.visible,
        locked: ancestorLocked || Boolean(object.userData.layerLocked) || this.isModelLocked(modelId),
        deleted: Boolean(object.userData.layerDeleted),
        children: object.userData.NodeType === "Element" ? [] : object.children
          .filter((child) => !child.name.startsWith("helper:") && !child.userData.layerDeleted)
          .map((child) => build(child, ancestorLocked || Boolean(object.userData.layerLocked)))
      });
      return build(model.object);
    }
  selectLayer(modelId: string, nodeId: string): void {
      this.focusedSpaceKey = undefined;
      if (nodeId === "root") {
        this.select(modelId);
        return;
      }
      const model = this.models.get(modelId);
      const fragmentEntry = this.fragmentLayers.get(modelId)?.get(nodeId);
      const fragmentModel = this.fragmentModels.get(modelId);
      if (model && fragmentEntry && fragmentModel) {
        this.selectedId = modelId;
        this.selectedFragmentNodeId = nodeId;
        this.inspectedObject = model.object;
        this.updatePostProcessingSelection();
        this.transform.detach();
        void this.highlightFragmentSelection(fragmentModel, fragmentEntry);
        this.onSelectionChange?.(model);
        return;
      }
      const object = this.layerObjects.get(modelId)?.get(nodeId);
      if (!model || !object) return;
      this.selectedId = modelId;
      this.selectedFragmentNodeId = undefined;
      this.inspectedObject = object;
      this.updatePostProcessingSelection();
      this.updateTransformAccess();
      this.updateSelectionHelper();
      this.onSelectionChange?.(model);
    }
  setLayerVisible(modelId: string, nodeId: string, visible: boolean): void {
      const model = this.models.get(modelId);
      const fragmentEntry = this.fragmentLayers.get(modelId)?.get(nodeId);
      const fragmentModel = this.fragmentModels.get(modelId);
      if (model && fragmentEntry && fragmentModel) {
        setTreeVisibility(fragmentEntry.node, visible);
        void fragmentModel.setVisible(fragmentEntry.localIds, visible).then(() => this.fragments?.update(true));
        this.updateLayerState(modelId, nodeId, { visible });
        this.updateSelectionHelper();
        this.markShadowMapDirty();
        this.onModelChange?.(model);
        return;
      }
      const object = this.layerObjects.get(modelId)?.get(nodeId);
      if (!model || !object) return;
      object.visible = visible;
      this.updateSelectionHelper();
      this.updateLayerState(modelId, nodeId, { visible });
      this.updateCollisions(true);
      this.markShadowMapDirty();
      this.onModelChange?.(model);
    }
  getLayerStates(modelId: string): SceneLayerState[] {
      return [...(this.layerStates.get(modelId)?.values() ?? [])]
        .filter((state) => state.nodeId !== "root")
        .map((state) => structuredClone(state));
    }
  applyLayerStates(modelId: string, states: SceneLayerState[] | undefined): void {
      this.layerStates.get(modelId)?.clear();
      for (const state of states ?? []) {
        const fragmentEntry = this.fragmentLayers.get(modelId)?.get(state.nodeId);
        const fragmentModel = this.fragmentModels.get(modelId);
        if (fragmentEntry && fragmentModel) {
          if (state.name !== undefined) fragmentEntry.node.name = state.name;
          if (state.locked !== undefined) setTreeLock(fragmentEntry.node, state.locked);
          const fragmentColor = state.material?.color ?? state.color;
          if (fragmentColor !== undefined) void fragmentModel.setColor(fragmentEntry.localIds, new THREE.Color(fragmentColor));
          if (state.opacity !== undefined) void fragmentModel.setOpacity(fragmentEntry.localIds, state.opacity);
          const visible = state.deleted ? false : state.visible;
          if (visible !== undefined) {
            setTreeVisibility(fragmentEntry.node, visible);
            void fragmentModel.setVisible(fragmentEntry.localIds, visible);
          }
          this.layerStates.get(modelId)?.set(state.nodeId, structuredClone(state));
          continue;
        }
        const object = this.layerObjects.get(modelId)?.get(state.nodeId);
        if (!object) continue;
        if (state.name !== undefined) object.name = state.name;
        if (state.locked !== undefined) object.userData.layerLocked = state.locked;
        if (state.transform) applyTransform(object, state.transform);
        if (state.opacity !== undefined) this.setObjectOpacity(object, state.opacity);
        if (state.color !== undefined) this.setObjectColor(object, state.color);
        if (state.material !== undefined) this.applyMaterialState(object, state.material);
        if (state.deleted) {
          object.userData.layerDeleted = true;
          object.visible = false;
        } else if (state.visible !== undefined) {
          object.visible = state.visible;
        }
        this.layerStates.get(modelId)?.set(state.nodeId, structuredClone(state));
      }
      this.rebuildComponentIndex(modelId);
      this.markShadowMapDirty();
    }
  renameSelection(name: string): void {
      const model = this.getSelected();
      const object = this.inspectedObject;
      if (!model) return;
      if (this.selectedFragmentNodeId) {
        const entry = this.fragmentLayers.get(model.id)?.get(this.selectedFragmentNodeId);
        if (!entry) return;
        entry.node.name = name;
        entry.properties.名称 = name;
        this.updateLayerState(model.id, this.selectedFragmentNodeId, { name });
        this.onModelChange?.(model);
        return;
      }
      if (!object) return;
      object.name = name;
      if (object === model.object) model.name = name;
      else this.updateLayerState(model.id, String(object.userData.layerNodeId), { name });
      this.rebuildComponentIndex(model.id);
      this.onModelChange?.(model);
    }
  setSelectionVisible(visible: boolean): void {
      const model = this.getSelected();
      const object = this.inspectedObject;
      if (!model || !object) return;
      if (this.selectedFragmentNodeId) {
        this.setLayerVisible(model.id, this.selectedFragmentNodeId, visible);
        return;
      }
      if (object === model.object) this.setVisible(model.id, visible);
      else this.setLayerVisible(model.id, String(object.userData.layerNodeId), visible);
    }
  setSelectionOpacity(opacity: number): void {
      const model = this.getSelected();
      const object = this.inspectedObject;
      if (!model) return;
      if (this.selectedFragmentNodeId) {
        const entry = this.fragmentLayers.get(model.id)?.get(this.selectedFragmentNodeId);
        const fragmentModel = this.fragmentModels.get(model.id);
        if (!entry || !fragmentModel) return;
        void fragmentModel.setOpacity(entry.localIds, opacity);
        this.updateLayerState(model.id, this.selectedFragmentNodeId, { opacity });
        this.onModelChange?.(model);
        return;
      }
      if (!object) return;
      if (object === model.object) this.setOpacity(model.id, opacity);
      else {
        this.setObjectOpacity(object, opacity);
        this.updateLayerState(model.id, String(object.userData.layerNodeId), { opacity });
        this.onModelChange?.(model);
      }
    }
  getSelectionTransform(): ModelTransform | undefined {
      const object = this.inspectedObject;
      if (!object) return undefined;
      return objectTransform(object);
    }
  applySelectionTransform(transform: ModelTransform): void {
      const model = this.getSelected();
      const object = this.inspectedObject;
      if (!model || !object || this.isSelectionLocked()) return;
      if (this.selectedFragmentNodeId && this.selectedFragmentNodeId !== "root") return;
      applyTransform(object, transform);
      if (object === model.object) this.authorModelTransforms.set(model.id, structuredClone(transform));
      object.updateWorldMatrix(true, true);
      if (object !== model.object) {
        this.updateLayerState(model.id, String(object.userData.layerNodeId), { transform });
      }
      this.updateCollisions(true);
      this.syncFragmentsTransformState(model.id);
      if (object === model.object) this.rebuildPhysicsBody(model.id);
      this.onModelChange?.(model);
    }
  deleteSelectedLayer(): boolean {
      const model = this.getSelected();
      const object = this.inspectedObject;
      if (model && this.isSelectionLocked()) return false;
      if (model && this.selectedFragmentNodeId && this.selectedFragmentNodeId !== "root") {
        const nodeId = this.selectedFragmentNodeId;
        const entry = this.fragmentLayers.get(model.id)?.get(nodeId);
        const fragmentModel = this.fragmentModels.get(model.id);
        if (!entry || !fragmentModel) return false;
        entry.node.deleted = true;
        setTreeVisibility(entry.node, false);
        void fragmentModel.setVisible(entry.localIds, false);
        this.updateLayerState(model.id, nodeId, { deleted: true, visible: false });
        this.select(model.id);
        this.onModelChange?.(model);
        return true;
      }
      if (!model || !object || object === model.object) return false;
      const nodeId = String(object.userData.layerNodeId);
      object.userData.layerDeleted = true;
      object.visible = false;
      this.updateLayerState(model.id, nodeId, { deleted: true, visible: false });
      this.rebuildComponentIndex(model.id);
      this.select(model.id);
      this.updateCollisions(true);
      this.onModelChange?.(model);
      return true;
    }
}
