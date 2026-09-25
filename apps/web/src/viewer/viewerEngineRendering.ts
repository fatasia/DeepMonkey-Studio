import type * as FRAGS from "@thatopen/fragments";
import DxfParser from "dxf-parser";
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { scalarText } from "./bimMetadata";
import { dxfDrawingExtents, dxfPoints, dxfUnitName, dxfUnitScale, pointsIntersectExtents, type DxfDocument } from "./dxfGeometry";
import { collectSpatialLocalIds, fragmentItemProperties, fragmentPropertyValue, humanizeIfcCategory } from "./fragmentTree";
import { isFiniteBox, objectTransform, visibleObjectBox } from "./sceneObjectUtils";
import { heatMapColor } from "./viewerStateUtils";
import type { ViewerPostProcessingRuntime } from "./viewerPostProcessingRuntime";
import { type LayerTreeNode, type LoadedSceneModel } from "./viewerTypes";
import { type FragmentLayerEntry } from "./viewerEngineTypes";
import { ViewerEngineLifecycle } from "./viewerEngineLifecycle";
import { loadViewerAssetText } from "./viewerAssetTransport";
import { syncSpaceVisualTransforms } from "./spaceVisualSync";
import { fitPerspectiveBox } from "./cameraFraming";
import { createModelFireEffect, disposeModelFireEffect, updateModelFireEffect } from "./modelFireEffect";
import type { DeepTransformGizmoInput } from "./deepOverlayPrimitives";

/** Rendering 职责层。 */
export abstract class ViewerEngineRendering extends ViewerEngineLifecycle {
  protected sceneContentBox(): THREE.Box3 {
      const box = new THREE.Box3();
      for (const model of this.models.values()) if (model.visible) box.union(visibleObjectBox(model.object));
      return box;
    }
  protected updateTransformAccess(): void {
      if (this.selectedSceneLight) {
        const object = this.selectedSceneLight.handle === "position"
          ? this.sceneLights.get(this.selectedSceneLight.id)
          : this.sceneLightTargets.get(this.selectedSceneLight.id);
        const editable = Boolean(object && !this.readOnlyMode && this.navigationMode === "orbit" && !this.sceneAnimationPlaying);
        this.transform.enabled = editable;
        if (editable && object) this.transform.attach(object);
        else this.transform.detach();
        this.transform.getHelper().visible = editable;
        return;
      }
      const object = this.inspectedObject;
      const editable = Boolean(
        object
        && !this.readOnlyMode
        && this.navigationMode === "orbit"
        && !this.sceneAnimationPlaying
        && !this.selectedFragmentNodeId
        && !this.isSelectionLocked()
      );
      this.transform.enabled = editable;
      if (editable && object) this.transform.attach(object);
      else this.transform.detach();
      this.transform.getHelper().visible = editable;
    }
  protected syncFragmentsTransformState(modelId: string, activelyTransforming = false): void {
      const fragmentsModel = this.fragmentModels.get(modelId);
      const object = this.models.get(modelId)?.object;
      if (!fragmentsModel || !object) return;
      const transformed = activelyTransforming
        || object.position.lengthSq() > 1e-10
        || Math.abs(object.quaternion.x) > 1e-7
        || Math.abs(object.quaternion.y) > 1e-7
        || Math.abs(object.quaternion.z) > 1e-7
        || Math.abs(object.quaternion.w - 1) > 1e-7
        || Math.abs(object.scale.x - 1) > 1e-7
        || Math.abs(object.scale.y - 1) > 1e-7
        || Math.abs(object.scale.z - 1) > 1e-7;
      fragmentsModel.frozen = transformed;
      if (!transformed) void this.fragments?.update(true);
    }
  protected updateSelectionHelper(): void {
      this.removeSelectionHelper();
      const selected = this.getSelected();
      const object = this.inspectedObject;
      if (!selected || !object || object === selected.object || !object.visible) return;
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      this.selectionHelper = new THREE.Box3Helper(box, 0x2684ff);
      this.selectionHelper.name = "helper:selection";
      this.selectionHelper.renderOrder = 999;
      const material = this.selectionHelper.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.toneMapped = false;
      material.transparent = true;
      material.opacity = 0.95;
      this.scene.add(this.selectionHelper);
    }
  protected updatePostProcessingSelection(): void {
      void this.syncPostProcessing();
    }
  /** 只有作者实际启用屏幕后效或对象轮廓时，才下载并创建 Composer。 */
    protected async syncPostProcessing(): Promise<void> {
      const needsPostProcessing = this.needsPostProcessing();
      if (!needsPostProcessing) {
        this.postProcessingRevision += 1;
        this.postProcessing?.suspend();
        // 切换场景时对象会短暂清空；延迟释放可避免 Composer 每次重建并重复分配纹理。
        if (this.postProcessing && this.postProcessingDisposeTimer === undefined) {
          this.postProcessingDisposeTimer = window.setTimeout(() => {
            this.postProcessingDisposeTimer = undefined;
            if (this.needsPostProcessing()) return;
            this.postProcessing?.dispose();
            this.postProcessing = undefined;
          }, 15_000);
        }
        return;
      }
      if (this.postProcessingDisposeTimer !== undefined) {
        window.clearTimeout(this.postProcessingDisposeTimer);
        this.postProcessingDisposeTimer = undefined;
      }
      const revision = ++this.postProcessingRevision;
      const runtime = this.postProcessing ?? await this.createPostProcessingRuntime();
      if (!runtime) return;
      // 多个开关在同一事件循环内变化时会并发等待同一个初始化 Promise。
      // 先登记唯一 runtime，再用 revision 丢弃过期参数，避免旧调用误释放当前管线。
      if (!this.postProcessing) this.postProcessing = runtime;
      if (runtime !== this.postProcessing) {
        runtime.dispose();
        return;
      }
      if (revision !== this.postProcessingRevision || !this.needsPostProcessing()) {
        return;
      }
      runtime.setPixelRatio(this.renderer.getPixelRatio());
      runtime.setSize(Math.max(this.container.clientWidth, 1), Math.max(this.container.clientHeight, 1));
      const outlined = [...this.modelEffects]
        .filter(([, effects]) => effects.outline)
        .map(([id]) => this.models.get(id)?.object)
        .filter((object): object is THREE.Object3D => Boolean(object?.visible));
      const selected = this.postProcessingState.enabled && this.postProcessingState.outline && this.inspectedObject?.visible
        ? [this.inspectedObject]
        : [];
      runtime.apply(this.postProcessingState, [...new Set([...outlined, ...selected])]);
      this.requestRender();
    }
  protected needsPostProcessing(): boolean {
      return this.postProcessingState.enabled || [...this.modelEffects.values()].some((effects) => effects.outline);
    }
  usesAuthorPostProcessing(): boolean {
    return !this.xrActive && !this.offscreen.wantsFrame() && this.needsPostProcessing() && Boolean(this.postProcessing);
  }
    protected async createPostProcessingRuntime(): Promise<ViewerPostProcessingRuntime | undefined> {
      if (this.postProcessing) return this.postProcessing;
      if (!this.postProcessingInit) {
        this.postProcessingInit = this.rendererBackend === "webgpu"
          ? import("./webGpuPostProcessingRuntime")
            .then(({ WebGpuPostProcessingRuntime }) => new WebGpuPostProcessingRuntime(this.renderer as WebGPURenderer, this.scene, this.camera))
          : import("./postProcessingRuntime")
            .then(({ PostProcessingRuntime }) => new PostProcessingRuntime(this.renderer as THREE.WebGLRenderer, this.scene, this.camera))
          .finally(() => { this.postProcessingInit = undefined; });
      }
      return this.postProcessingInit;
    }
  protected restoreModelEffectMaterials(id: string): void {
      const runtime = this.modelEffectRuntimes.get(id);
      if (!runtime) return;
      for (const [mesh, material] of runtime.originals) if (mesh.parent) mesh.material = material;
      runtime.generated.forEach((material) => material.dispose());
      runtime.generated.length = 0;
      if (runtime.fire) {
        // WebGPU 通过 Viewer 的退休队列延迟销毁，避免释放仍在当前提交中使用的 Buffer。
        disposeModelFireEffect(runtime.fire, (object) => this.disposeObject(object));
        delete runtime.fire;
      }
      if (runtime.helper) {
        this.disposeObject(runtime.helper);
        delete runtime.helper;
        delete runtime.scan;
      }
    }
  protected rebuildModelEffects(id: string): void {
      const model = this.models.get(id);
      const state = this.modelEffects.get(id);
      let runtime = this.modelEffectRuntimes.get(id);
      if (runtime) this.restoreModelEffectMaterials(id);
      const fireEnabled = state?.fire?.enabled === true;
      const enabled = state && (state.outline || state.glow || state.xray || state.scanline || state.heatmap || state.dissolve > 0 || state.edgeLight || fireEnabled);
      if (!model || !state || !enabled) {
        if (runtime) this.modelEffectRuntimes.delete(id);
        this.updatePostProcessingSelection();
        return;
      }
      // 轮廓由后处理节点完成，不需要替换模型材质；避免场景切换时重复克隆材质并触发新的 WebGPU 管线变体。
      const requiresMaterialOverride = Boolean(
        state.glow || state.xray || state.scanline || state.heatmap || state.dissolve > 0 || state.edgeLight,
      );
      if (!requiresMaterialOverride && !fireEnabled) {
        this.modelEffectRuntimes.delete(id);
        this.updatePostProcessingSelection();
        return;
      }
      if (!runtime) {
        runtime = { originals: new Map(), generated: [] };
        this.modelEffectRuntimes.set(id, runtime);
      }
      if (!requiresMaterialOverride) runtime.originals.clear();
      if (requiresMaterialOverride && runtime.originals.size === 0) {
        model.object.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh && mesh.material && !child.name.startsWith("helper:")) runtime!.originals.set(mesh, mesh.material);
        });
      }
      const modelBox = new THREE.Box3().setFromObject(model.object);
      const minY = modelBox.min.y;
      const height = Math.max(modelBox.max.y - minY, 0.001);
      for (const [mesh, original] of runtime.originals) {
        if (!mesh.parent) continue;
        const sources = Array.isArray(original) ? original : [original];
        const meshCenter = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
        const heat = THREE.MathUtils.clamp((meshCenter.y - minY) / height, 0, 1);
        const clones = sources.map((source) => {
          const material = source.clone() as THREE.Material & {
            color?: THREE.Color;
            emissive?: THREE.Color;
            emissiveIntensity?: number;
            opacity: number;
            alphaHash?: boolean;
          };
          if (state.heatmap && material.color?.isColor) material.color.copy(heatMapColor(heat));
          if ((state.glow || state.edgeLight) && material.emissive?.isColor) {
            material.emissive.set(state.color);
            material.emissiveIntensity = state.intensity * (state.edgeLight ? 1.4 : 0.8);
          }
          if (state.xray) {
            if (material.color?.isColor) material.color.set(state.color);
            material.transparent = true;
            material.opacity = 0.24;
            material.depthTest = false;
            material.depthWrite = false;
            material.side = THREE.DoubleSide;
          } else if (state.dissolve > 0) {
            material.alphaHash = true;
            material.transparent = false;
            material.opacity = Math.max(0.02, 1 - state.dissolve);
            material.depthWrite = true;
          }
          material.needsUpdate = true;
          runtime!.generated.push(material);
          return material;
        });
        mesh.material = Array.isArray(original) ? clones : clones[0]!;
      }
  
      const helper = new THREE.Group();
      helper.name = `helper:model-effects:${id}`;
      helper.userData.effectHelper = true;
      if (state.scanline && !modelBox.isEmpty()) {
        const size = modelBox.getSize(new THREE.Vector3());
        const center = modelBox.getCenter(new THREE.Vector3());
        const material = new THREE.MeshBasicMaterial({ color: state.color, transparent: true, opacity: 0.58, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
        const scan = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x, 0.2), Math.max(size.y * 0.008, 0.015), Math.max(size.z, 0.2)), material);
        scan.position.set(center.x, modelBox.min.y, center.z);
        scan.renderOrder = 28;
        helper.add(scan);
        runtime.scan = { mesh: scan, minY: modelBox.min.y, maxY: modelBox.max.y, phase: 0 };
      }
      if (helper.children.length > 0) {
        runtime.helper = helper;
        this.scene.add(helper);
      }
      if (fireEnabled && state.fire) {
        const fire = createModelFireEffect(model.object, state.fire);
        if (fire) runtime.fire = fire;
      }
      this.updatePostProcessingSelection();
      this.scheduleRendererPipelineWarmup();
    }
  protected updateModelEffects(delta: number): void {
      for (const runtime of this.modelEffectRuntimes.values()) {
        if (runtime.scan) {
          runtime.scan.phase = (runtime.scan.phase + delta * 0.32) % 1;
          runtime.scan.mesh.position.y = THREE.MathUtils.lerp(runtime.scan.minY, runtime.scan.maxY, runtime.scan.phase);
        }
        if (runtime.fire) updateModelFireEffect(runtime.fire, delta);
      }
    }
  protected removeSelectionHelper(): void {
      if (!this.selectionHelper) return;
      this.scene.remove(this.selectionHelper);
      this.selectionHelper.geometry.dispose();
      (this.selectionHelper.material as THREE.Material).dispose();
      this.selectionHelper = undefined;
    }
  protected emitCameraChange(force = false): void {
      if (!this.hasCameraChangeObservers()) return;
      // 快速路径：相机原始数值逐位未变时，签名串(toFixed 确定性)必然与上一帧相同，
      // 直接早退，避免每帧 2 次 Vector clone、6 次 toFixed 与字符串拼接。
      const position = this.camera.position, target = this.orbit.target, mode = this.navigationMode;
      const raw: readonly [number, number, number, number, number, number, string] =
        [position.x, position.y, position.z, target.x, target.y, target.z, mode];
      const previousRaw = this.lastCameraRaw;
      if (!force && previousRaw && previousRaw[0] === raw[0] && previousRaw[1] === raw[1] && previousRaw[2] === raw[2]
        && previousRaw[3] === raw[3] && previousRaw[4] === raw[4] && previousRaw[5] === raw[5] && previousRaw[6] === raw[6]) return;
      this.lastCameraRaw = raw;
      const state = this.getCameraState();
      const signature = `${state.position.x.toFixed(4)}:${state.position.y.toFixed(4)}:${state.position.z.toFixed(4)}:${state.target.x.toFixed(4)}:${state.target.y.toFixed(4)}:${state.target.z.toFixed(4)}:${state.mode}`;
      if (!force && signature === this.lastCameraSignature) return;
      this.lastCameraSignature = signature;
      this.publishCameraChange(state);
    }
  protected registerObject(id: string, name: string, object: THREE.Object3D, kind: LoadedSceneModel["kind"]): LoadedSceneModel {
      object.name = name;
      object.userData.modelId = id;
      const objects = this.indexModelObject(id, object);
      this.modelRoot.add(object);
      const loaded = { id, name, object, kind, visible: true, opacity: 1 } satisfies LoadedSceneModel;
      this.models.set(id, loaded);
      this.authorModelTransforms?.set(id, structuredClone(objectTransform(object)));
      this.layerObjects.set(id, objects);
      this.layerStates.set(id, new Map());
      this.captureModelBoneRestPose(id);
      this.rebuildComponentIndex(id);
      this.markShadowMapDirty();
      this.scheduleRendererPipelineWarmup();
      return loaded;
    }
  protected indexModelObject(id: string, object: THREE.Object3D): Map<string, THREE.Object3D> {
      const objects = new Map<string, THREE.Object3D>();
      const indexObject = (child: THREE.Object3D, nodeId: string): void => {
        child.userData.modelId = id;
        const elementId = scalarText(child.userData.ElementId);
        const preferredId = elementId && child.userData.NodeType === "Element" ? `element:${elementId}` : nodeId;
        const stableNodeId = objects.has(preferredId) ? nodeId : preferredId;
        child.userData.layerNodeId = stableNodeId;
        objects.set(stableNodeId, child);
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
        child.children.forEach((nested, index) => indexObject(nested, `${nodeId}/${index}`));
      };
      indexObject(object, "root");
      return objects;
    }
  protected async registerFragmentsModel(modelId: string, fragmentsModel: FRAGS.FragmentsModel, sourceName: string): Promise<void> {
      this.fragmentModels.set(modelId, fragmentsModel);
      const spatial = await fragmentsModel.getSpatialStructure();
      const localIds = [...collectSpatialLocalIds(spatial)];
      const itemData = new Map<number, FRAGS.ItemData>();
  
      const entries = new Map<string, FragmentLayerEntry>();
      const idsByLocalId = new Map<number, string>();
      const build = (item: FRAGS.SpatialTreeItem, path: string, isRoot = false): FragmentLayerEntry => {
        const ownId = item.localId ?? undefined;
        const properties = ownId === undefined ? {} : fragmentItemProperties(itemData.get(ownId));
        const nodeId = isRoot ? "root" : ownId === undefined ? `ifc-group:${path}` : `ifc:${ownId}`;
        const childrenEntries = (item.children ?? []).map((child, index) => build(child, `${path}/${index}`));
        const localIdsForNode = ownId === undefined
          ? [...new Set(childrenEntries.flatMap((child) => child.localIds))]
          : [...new Set([ownId, ...childrenEntries.flatMap((child) => child.localIds)])];
        const fallback = isRoot ? sourceName : humanizeIfcCategory(item.category) || `构件 ${ownId ?? path}`;
        const name = fragmentPropertyValue(properties, ["Name", "LongName", "ObjectType", "名称"]) || fallback;
        const node: LayerTreeNode = {
          id: nodeId,
          modelId,
          name,
          type: item.category || (isRoot ? "IFC 模型" : "IFC 分组"),
          visible: true,
          locked: false,
          deleted: false,
          children: childrenEntries.map((child) => child.node)
        };
        const entry = { node, localIds: localIdsForNode, ...(ownId === undefined ? {} : { localId: ownId }), properties };
        entries.set(nodeId, entry);
        if (ownId !== undefined) idsByLocalId.set(ownId, nodeId);
        return entry;
      };
  
      const root = build(spatial, "0", true);
      this.fragmentLayers.set(modelId, entries);
      this.fragmentTrees.set(modelId, root.node);
      this.fragmentNodeIdsByLocalId.set(modelId, idsByLocalId);
      this.rebuildComponentIndex(modelId);
      this.onModelChange?.(this.models.get(modelId)!);
      void this.hydrateFragmentProperties(modelId, fragmentsModel, localIds);
    }
  protected async hydrateFragmentProperties(modelId: string, fragmentsModel: FRAGS.FragmentsModel, localIds: number[]): Promise<void> {
      for (let offset = 0; offset < localIds.length; offset += 300) {
        if (this.fragmentModels.get(modelId) !== fragmentsModel) return;
        const ids = localIds.slice(offset, offset + 300);
        const values = await fragmentsModel.getItemsData(ids);
        ids.forEach((localId, index) => {
          const nodeId = this.fragmentNodeIdsByLocalId.get(modelId)?.get(localId);
          const entry = nodeId ? this.fragmentLayers.get(modelId)?.get(nodeId) : undefined;
          const value = values[index];
          if (!entry || !value) return;
          entry.properties = fragmentItemProperties(value);
          const name = fragmentPropertyValue(entry.properties, ["Name", "LongName", "ObjectType", "名称"]);
          if (name) entry.node.name = name;
        });
        this.rebuildComponentIndex(modelId);
        const model = this.models.get(modelId);
        if (model) this.onModelChange?.(model);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  protected ensureFragmentEntry(modelId: string, localId: number): string | undefined {
      const entries = this.fragmentLayers.get(modelId);
      const root = this.fragmentTrees.get(modelId);
      if (!entries || !root) return undefined;
      const nodeId = `ifc:${localId}`;
      const existing = entries.get(nodeId);
      if (existing) {
        this.fragmentNodeIdsByLocalId.get(modelId)?.set(localId, nodeId);
        return nodeId;
      }
      const node: LayerTreeNode = {
        id: nodeId,
        modelId,
        name: `构件 ${localId}`,
        type: "IFC 构件",
        visible: true,
        locked: false,
        deleted: false,
        children: []
      };
      root.children.push(node);
      entries.set(nodeId, { node, localIds: [localId], localId, properties: { LocalId: String(localId) } });
      this.fragmentNodeIdsByLocalId.get(modelId)?.set(localId, nodeId);
      this.rebuildComponentIndex(modelId);
      const model = this.models.get(modelId);
      if (model) this.onModelChange?.(model);
      const fragmentsModel = this.fragmentModels.get(modelId);
      if (fragmentsModel) {
        void fragmentsModel.getItemsData([localId]).then(([data]) => {
          const entry = this.fragmentLayers.get(modelId)?.get(nodeId);
          if (!entry || !data) return;
          entry.properties = fragmentItemProperties(data);
          const name = fragmentPropertyValue(entry.properties, ["Name", "LongName", "ObjectType", "名称"]);
          const category = fragmentPropertyValue(entry.properties, ["Category", "category", "类型"]);
          if (name) entry.node.name = name;
          if (category) entry.node.type = category;
          this.rebuildComponentIndex(modelId);
          if (model) this.onModelChange?.(model);
        });
      }
      return nodeId;
    }
  protected async highlightFragmentSelection(fragmentModel: FRAGS.FragmentsModel, entry: FragmentLayerEntry): Promise<void> {
      const version = ++this.fragmentSelectionVersion;
      await fragmentModel.resetHighlight();
      if (version !== this.fragmentSelectionVersion || this.selectedFragmentNodeId !== entry.node.id) return;
      await fragmentModel.highlight(entry.localIds, {
        color: new THREE.Color(0x2684ff),
        renderedFaces: this.requireFragmentRuntime().api.RenderedFaces.TWO,
        opacity: 0.42,
        transparent: true,
        preserveOriginalMaterial: true,
        depthTest: true,
        depthWrite: false,
        customId: "bim-studio-selection"
      });
      const box = await fragmentModel.getMergedBox(entry.localIds);
      if (version !== this.fragmentSelectionVersion || this.selectedFragmentNodeId !== entry.node.id) return;
      this.showSelectionBox(box);
      void this.fragments?.update(true);
    }
  protected focusBox(box: THREE.Box3, direction = new THREE.Vector3(1, 0.72, 1), up = new THREE.Vector3(0, 1, 0)): boolean {
      const frame = fitPerspectiveBox(box, this.camera, this.cameraConstraints, direction, up);
      if (!frame) return false;
      const { center, distance } = frame;
      this.camera.up.copy(up);
      this.orbit.target.copy(center);
      this.camera.position.copy(center).addScaledVector(direction.clone().normalize(), distance);
      this.configureNavigationControls(this.navigationMode);
      this.camera.up.copy(up);
      this.applyCameraClippingRange();
      this.orbit.update();
      this.resetCameraCollisionAnchor();
      // Programmatic camera moves can happen while demand rendering is idle
      // (for example, releasing the orientation cube outside the canvas).
      // Wake the renderer explicitly so the canvas and camera HUD stay in sync.
      this.requestRender();
      this.emitCameraChange(true);
      return true;
    }
  protected prepareForFocusedView(): void {
      if (this.sceneAnimationPlaying) this.pauseSceneAnimation();
      if (this.navigationMode !== "orbit") this.setNavigationMode("orbit");
      this.camera.up.set(0, 1, 0);
      this.configureNavigationControls("orbit");
    }
  protected syncSpaceVisuals(): void {
      syncSpaceVisualTransforms(this.spaceVisuals.values(), this.models);
    }
  protected showSelectionBox(box: THREE.Box3): void {
      this.removeSelectionHelper();
      if (box.isEmpty()) return;
      this.selectionHelper = new THREE.Box3Helper(box, 0x2684ff);
      this.selectionHelper.name = "helper:selection";
      this.selectionHelper.renderOrder = 999;
      const material = this.selectionHelper.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      material.toneMapped = false;
      material.transparent = true;
      material.opacity = 0.95;
      this.scene.add(this.selectionHelper);
    }
  /** Deep 原生选择盒原语(切片 A)的只读输入;Box3 即 WebGL 路径呈现所用的同一份。 */
  getDeepSelectionBox(): THREE.Box3 | undefined {
      return this.selectionHelper?.box;
    }
  /** Deep 原生 gizmo 原语(切片 C)的只读输入;呈现层原生化,交互仍由 TransformControls 持有。 */
  getDeepTransformGizmoInput(): DeepTransformGizmoInput | undefined {
      const object = this.transform.object;
      const mode = this.transform.mode;
      if (!this.transform.getHelper().visible || !object) return undefined;
      if (mode !== "translate" && mode !== "rotate" && mode !== "scale") return undefined;
      return { matrix: object.matrixWorld, mode };
    }
  protected async loadDxf(url: string): Promise<THREE.Group> {
      const source = await loadViewerAssetText(url, "DXF");
      const document = new DxfParser().parseSync(source) as DxfDocument | null;
      if (!document) throw new Error("DXF 内容无效");
      const root = new THREE.Group();
      const group = new THREE.Group();
      group.name = "CAD 图纸";
      root.add(group);
      const layerGroups = new Map<string, THREE.Group>();
      const modelExtents = dxfDrawingExtents(document.header);
      for (const entity of document.entities ?? []) {
        const points = dxfPoints(entity);
        if (points.length < 2) continue;
        if (modelExtents && !pointsIntersectExtents(points, modelExtents)) continue;
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const closed = entity.type === "LWPOLYLINE" && points.length > 2;
        const layerName = entity.layer?.trim() || "默认图层";
        let layer = layerGroups.get(layerName);
        if (!layer) {
          layer = new THREE.Group();
          layer.name = layerName;
          layer.userData.layer = layerName;
          layerGroups.set(layerName, layer);
          group.add(layer);
        }
        const material = new THREE.LineBasicMaterial({ color: 0xd9dee5 });
        const line = closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
        line.name = `${entity.type ?? "实体"} ${layer.children.length + 1}`;
        layer.add(line);
      }
      const unitScale = dxfUnitScale(document.header?.["$INSUNITS"]);
      group.rotation.x = -Math.PI / 2;
      group.scale.setScalar(unitScale);
      group.updateWorldMatrix(true, true);
      const bounds = new THREE.Box3().setFromObject(group);
      if (!bounds.isEmpty()) {
        const center = bounds.getCenter(new THREE.Vector3());
        group.position.sub(center);
        root.userData.CadOriginalCenter = { x: center.x, y: center.y, z: center.z };
        root.userData.CadUnitScale = unitScale;
        root.userData.CadSourceUnits = dxfUnitName(document.header?.["$INSUNITS"]);
      }
      return root;
    }
}
