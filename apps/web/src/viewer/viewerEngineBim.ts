import type * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { exportFbxAscii } from "./fbxExporter";
import { componentFacets, filterComponents, type ComponentFacets, type ComponentFilter, type ComponentRecord } from "./analysis";
import { firstProperty, uniqueComponentRecords, vectorValue, type NativeBimSpaceMetadata } from "./bimMetadata";
import { isAncestorOf, isFiniteBox, normalizedSpaceBox, objectMeshCount, objectVisibleMeshCount, prepareCompleteExportObject, sanitizeExportObject, spaceVisualKey } from "./sceneObjectUtils";
import { associateSpace, evaluatePlacement, planBimQuestion, relevantProperties, type BimAssistantComponentEvidence, type BimAssistantPreparedContext, type BimBoundsValue } from "../bimAssistant";
import { type BimSpaceRecord, type LoadedSceneModel } from "./viewerTypes";
import { ViewerEngineSimulation } from "./viewerEngineSimulation";

/** Bim 职责层。 */
export abstract class ViewerEngineBim extends ViewerEngineSimulation {
  searchComponents(filter: ComponentFilter, limit = 100): ComponentRecord[] {
      const records = [...this.componentRecords.values()].flat().filter((record) => {
        const object = this.layerObjects.get(record.modelId)?.get(record.id);
        return object && !object.userData.layerDeleted;
      });
      return filterComponents(records, filter, limit);
    }
  getComponentFacets(): ComponentFacets {
      return componentFacets([...this.componentRecords.values()].flat());
    }
  getComponentCount(): number {
      return [...this.componentRecords.values()].reduce((total, records) => total + records.length, 0);
    }
  async prepareBimAssistantContext(question: string): Promise<BimAssistantPreparedContext> {
      const records = [...this.componentRecords.values()].flat().filter((record) => {
        const fragment = this.fragmentLayers.get(record.modelId)?.get(record.id);
        const object = this.layerObjects.get(record.modelId)?.get(record.id);
        return fragment ? !fragment.node.deleted : Boolean(object && !object.userData.layerDeleted);
      });
      const spaces = this.getSpaces();
      const plan = planBimQuestion(question, records);
      const selected = this.getSelectedComponentRecord();
      const useSelected = Boolean(selected && (plan.matches.length === 0 || /(当前|这个|选中|所选|selected|this component)/i.test(question)));
      const candidates = uniqueComponentRecords([...(useSelected && selected ? [selected] : []), ...plan.matches]).slice(0, plan.intents.includes("placement") ? 12 : 30);
      const matches: BimAssistantComponentEvidence[] = [];
      for (const record of candidates) {
        const bounds = await this.componentBounds(record);
        const space = associateSpace(bounds, record.modelId, spaces);
        matches.push({
          id: record.id,
          stableId: record.stableId,
          modelId: record.modelId,
          modelName: record.modelName,
          name: record.name,
          type: record.type,
          ...(record.category ? { category: record.category } : {}),
          ...(record.level ? { level: record.level } : {}),
          properties: relevantProperties(record.properties, question),
          ...(bounds ? { bounds } : {}),
          ...(space ? { space: { id: space.id, name: space.name, ...(space.number ? { number: space.number } : {}), level: space.level } } : {})
        });
      }
      const categories = new Map<string, number>();
      const levelCounts = new Map<string, number>();
      const systems = new Map<string, number>();
      for (const record of records) {
        const category = record.category || record.type || "未分类";
        categories.set(category, (categories.get(category) ?? 0) + 1);
        const level = record.level || "未指定楼层";
        levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
        const system = firstProperty(record.properties, ["System Name", "SystemName", "System", "系统名称", "系统", "回路", "Circuit Number", "Circuit"]);
        if (system) systems.set(system, (systems.get(system) ?? 0) + 1);
      }
      const placement = plan.requestedSizeMetres ? evaluatePlacement(plan.requestedSizeMetres, matches) : undefined;
      const inventoryQuestion = /(有哪些|多少个|总数|统计|概览).*(模型|构件|类别|专业|楼层|空间|房间)|(模型|构件|类别|专业|楼层|空间|房间).*(有哪些|多少个|总数|统计|概览)/i.test(question);
      const limitations: string[] = [];
      if (plan.matches.length === 0 && !inventoryQuestion) limitations.push("没有找到与问题匹配的已加载构件；请使用构件名称、编号、类别或先选中构件。 ");
      if (matches.some((item) => !item.bounds)) limitations.push("部分构件缺少可用几何边界，无法给出坐标、尺寸或净空结论。 ");
      if (placement) limitations.push("设备试放采用世界坐标轴对齐包围盒初筛；正式落位仍应执行精确碰撞和工艺检修空间校核。 ");
      return {
        schema: "bim-studio/bim-assistant-context@1",
        question,
        intents: plan.intents,
        confidence: inventoryQuestion ? "exact" : plan.matches.length === 0 ? "insufficient" : plan.aliases.length > 0 || Boolean(selected) ? "exact" : "inferred",
        scene: {
          modelCount: this.models.size,
          componentCount: records.length,
          spaceCount: spaces.length,
          levels: [...new Set(records.map((record) => record.level).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, "zh-CN")),
          levelCounts: [...levelCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
          categories: [...categories].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 80),
          systems: [...systems].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 80)
        },
        query: { aliases: plan.aliases, ...(plan.requestedSizeMetres ? { requestedSizeMetres: plan.requestedSizeMetres } : {}) },
        matchCount: plan.matchCount,
        matches,
        ...(placement ? { placement } : {}),
        limitations
      };
    }
  applyBimAssistantAction(action: "focus" | "isolate" | "show-placement" | "clear-isolation" | "clear-placement", context: BimAssistantPreparedContext, componentId?: string): boolean {
      if (action === "clear-isolation") { this.clearIsolation(); return true; }
      if (action === "clear-placement") { this.clearBimPlacementPreview(); return true; }
      if (action === "show-placement") {
        const placement = context.placement;
        if (!placement?.candidateCenter) return false;
        this.clearBimPlacementPreview();
        const { length, width, height } = placement.requestedSizeMetres;
        const material = new THREE.MeshBasicMaterial({ color: placement.status === "fits" ? 0x35d07f : 0xff4757, transparent: true, opacity: 0.35, depthWrite: false });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), material);
        mesh.position.set(placement.candidateCenter.x, placement.candidateCenter.y, placement.candidateCenter.z);
        mesh.name = "helper:bim-placement-preview";
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: placement.status === "fits" ? 0x55ef9f : 0xff6b81 }));
        mesh.add(edges);
        this.scene.add(mesh);
        this.bimPlacementPreview = mesh;
        this.focusObject(mesh);
        return true;
      }
      const evidence = componentId ? context.matches.find((item) => item.id === componentId || item.stableId === componentId) : context.matches[0];
      if (!evidence) return false;
      const record = this.componentRecord(evidence.modelId, evidence.id);
      if (!record) return false;
      if (action === "focus") this.focusComponent(record);
      else this.isolateComponents([record]);
      return true;
    }
  protected clearBimPlacementPreview(): void {
      if (!this.bimPlacementPreview) return;
      this.disposeObject(this.bimPlacementPreview);
      this.bimPlacementPreview = undefined;
    }
  protected async componentBounds(record: ComponentRecord): Promise<BimBoundsValue | undefined> {
      const fragment = this.fragmentLayers.get(record.modelId)?.get(record.id);
      const fragmentModel = this.fragmentModels.get(record.modelId);
      let box: THREE.Box3 | undefined;
      if (fragment && fragmentModel) box = await fragmentModel.getMergedBox(fragment.localIds).catch(() => undefined);
      else {
        const object = this.layerObjects.get(record.modelId)?.get(record.id);
        if (object) box = new THREE.Box3().setFromObject(object);
      }
      if (!box || !isFiniteBox(box) || box.isEmpty()) return undefined;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      return { min: vectorValue(box.min), max: vectorValue(box.max), center: vectorValue(center), size: vectorValue(size) };
    }
  getSpaces(): BimSpaceRecord[] {
      const output: BimSpaceRecord[] = [];
      for (const model of this.models.values()) {
        const nativeSpaces = model.object.userData.BimSpaces as Record<string, NativeBimSpaceMetadata> | undefined;
        if (nativeSpaces && Object.keys(nativeSpaces).length > 0) {
          for (const [id, space] of Object.entries(nativeSpaces)) {
            output.push({
              id: space.spaceId ?? id,
              modelId: model.id,
              modelName: model.name,
              name: space.name || `空间 ${id}`,
              ...(space.number ? { number: space.number } : {}),
              level: space.level || "未指定楼层",
              kind: space.kind || "Room",
              ...(space.department ? { department: space.department } : {}),
              ...(space.areaSquareMetres === undefined ? {} : { areaSquareMetres: space.areaSquareMetres }),
              ...(space.volumeCubicMetres === undefined ? {} : { volumeCubicMetres: space.volumeCubicMetres }),
              ...(space.bounds ? { bounds: structuredClone(space.bounds) } : {}),
              ...(space.parameters ? {
                parameters: space.parameters.flatMap((parameter) => parameter.name && parameter.value !== undefined ? [{
                  name: parameter.name,
                  value: parameter.value,
                  ...(parameter.groupTypeId ? { group: parameter.groupTypeId } : {})
                }] : [])
              } : {})
            });
          }
          continue;
        }
        for (const component of this.componentRecords.get(model.id) ?? []) {
          const descriptor = [component.type, component.category, component.name, ...Object.values(component.properties)].join(" ").toLocaleLowerCase("zh-CN");
          if (!/(ifcspace|\bspace\b|\broom\b|空间|房间)/i.test(descriptor)) continue;
          const number = firstProperty(component.properties, ["Number", "LongName", "编号", "房间编号"]);
          output.push({
            id: component.stableId,
            modelId: model.id,
            modelName: model.name,
            name: component.name,
            ...(number ? { number } : {}),
            level: component.level || "未指定楼层",
            kind: component.type,
            componentId: component.id
          });
        }
      }
      return output.sort((a, b) => a.modelName.localeCompare(b.modelName, "zh-CN") || a.level.localeCompare(b.level, "zh-CN") || (a.number ?? a.name).localeCompare(b.number ?? b.name, "zh-CN"));
    }
  focusSpace(space: BimSpaceRecord): boolean {
      if (space.componentId) {
        const component = this.componentRecord(space.modelId, space.componentId);
        if (component) {
          this.prepareForFocusedView();
          this.focusComponent(component);
          return true;
        }
      }
      const model = this.models.get(space.modelId);
      if (!model || !space.bounds) return false;
      const localBox = normalizedSpaceBox(space.bounds);
      if (!localBox) return false;
      this.prepareForFocusedView();
      this.select(undefined);
      model.object.updateWorldMatrix(true, true);
      const box = localBox.clone().applyMatrix4(model.object.matrixWorld);
      if (!this.focusBox(box)) return false;
      this.setSpaceVisible(space, true);
      this.focusedSpaceKey = spaceVisualKey(space);
      this.showSelectionBox(box);
      return true;
    }
  isSpaceVisible(space: BimSpaceRecord): boolean {
      return this.spaceVisuals.has(spaceVisualKey(space));
    }
  setSpaceVisible(space: BimSpaceRecord, visible: boolean): boolean {
      const key = spaceVisualKey(space);
      const current = this.spaceVisuals.get(key);
      if (!visible) {
        if (current) {
          this.disposeObject(current.object);
          this.spaceVisuals.delete(key);
        }
        if (this.focusedSpaceKey === key) {
          this.removeSelectionHelper();
          this.focusedSpaceKey = undefined;
        }
        return true;
      }
      if (current) return true;
      const model = this.models.get(space.modelId);
      const box = space.bounds ? normalizedSpaceBox(space.bounds) : undefined;
      if (!model || !box) return false;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const group = new THREE.Group();
      group.name = `helper:space:${key}`;
      group.userData.spaceId = space.id;
      group.userData.modelId = space.modelId;
      group.matrixAutoUpdate = false;
      const fill = new THREE.Mesh(
        new THREE.BoxGeometry(size.x, size.y, size.z),
        new THREE.MeshBasicMaterial({
          color: 0x31c8de,
          transparent: true,
          opacity: 0.18,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide
        })
      );
      fill.position.copy(center);
      fill.name = "helper:space-fill";
      fill.renderOrder = 850;
      fill.raycast = () => undefined;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(fill.geometry),
        new THREE.LineBasicMaterial({ color: 0x55dced, transparent: true, opacity: 0.9, depthTest: false })
      );
      edges.position.copy(center);
      edges.name = "helper:space-edges";
      edges.renderOrder = 851;
      edges.raycast = () => undefined;
      group.add(fill, edges);
      this.scene.add(group);
      this.spaceVisuals.set(key, { modelId: space.modelId, object: group });
      this.syncSpaceVisuals();
      return true;
    }
  setSpacesVisible(spaces: BimSpaceRecord[], visible: boolean): number {
      let changed = 0;
      for (const space of spaces) if (this.setSpaceVisible(space, visible)) changed += 1;
      return changed;
    }
  getSelectedComponentRecord(): ComponentRecord | undefined {
      if (!this.selectedId) return undefined;
      return this.componentRecord(this.selectedId, this.getSelectedLayerId() ?? "root");
    }
  focusComponent(record: ComponentRecord): void {
      this.selectLayer(record.modelId, record.id);
      const fragmentEntry = this.fragmentLayers.get(record.modelId)?.get(record.id);
      const fragmentModel = this.fragmentModels.get(record.modelId);
      if (fragmentEntry && fragmentModel) {
        void fragmentModel.getMergedBox(fragmentEntry.localIds).then((box) => this.focusBox(box));
        return;
      }
      const object = this.layerObjects.get(record.modelId)?.get(record.id);
      if (object) this.focusObject(object);
    }
  isolateComponents(records: ComponentRecord[]): void {
      const targets = records.flatMap((record) => {
        const object = this.layerObjects.get(record.modelId)?.get(record.id);
        return object ? [object] : [];
      });
      this.isolateObjects(targets);
    }
  isolateModels(modelIds: string[]): void {
      const targets = [...new Set(modelIds)].flatMap((id) => {
        const object = this.models.get(id)?.object;
        return object ? [object] : [];
      });
      this.isolateObjects(targets);
    }
  protected isolateObjects(targets: THREE.Object3D[]): void {
      this.clearIsolation();
      if (targets.length === 0) return;
      for (const model of this.models.values()) {
        model.object.traverse((object) => {
          this.isolationVisibility.set(object, object.visible);
          const related = targets.some((target) => object === target || isAncestorOf(object, target) || isAncestorOf(target, object));
          object.visible = related && !object.userData.layerDeleted;
        });
      }
      this.updateCollisions(true);
      this.onCollisionChange?.();
    }
  clearIsolation(): void {
      if (this.isolationVisibility.size === 0) return;
      for (const [object, visible] of this.isolationVisibility) object.visible = visible;
      this.isolationVisibility.clear();
      this.updateCollisions(true);
      this.onCollisionChange?.();
    }
  isIsolationActive(): boolean {
      return this.isolationVisibility.size > 0;
    }
  getSelected(): LoadedSceneModel | undefined {
      return this.selectedId ? this.models.get(this.selectedId) : undefined;
    }
  async exportSceneGlb(options: { scope?: "all" | "visible" } = {}): Promise<ArrayBuffer> {
      for (const model of this.models.values()) this.setCollisionHighlight(model, false);
      const exportRoot = new THREE.Group();
      exportRoot.name = "Deep Monkey Studio Scene";
      const includeHidden = options.scope !== "visible";
      const animations: THREE.AnimationClip[] = [];
      let meshCount = 0;
      const generatedFragmentRoots: THREE.Group[] = [];
      try {
        for (const model of this.models.values()) {
        if (!includeHidden && (!model.visible || !model.object.visible)) continue;
        const fragmentsModel = this.fragmentModels.get(model.id);
        if (fragmentsModel) {
          const fragmentRoot = await this.buildFragmentsExportObject(model, fragmentsModel, includeHidden);
          const fragmentMeshCount = includeHidden ? objectMeshCount(fragmentRoot) : objectVisibleMeshCount(fragmentRoot);
          if (fragmentMeshCount > 0) {
            meshCount += fragmentMeshCount;
            generatedFragmentRoots.push(fragmentRoot);
            exportRoot.add(fragmentRoot);
          }
          continue;
        }
        const clone = model.object.clone(true);
        if (includeHidden) prepareCompleteExportObject(clone);
        else sanitizeExportObject(clone);
        const currentMeshCount = includeHidden ? objectMeshCount(clone) : objectVisibleMeshCount(clone);
        meshCount += currentMeshCount;
        exportRoot.add(clone);
        animations.push(...(this.animationClips.get(model.id) ?? []).map((clip) => clip.clone()));
        }
        if (meshCount === 0) {
          throw new Error("当前场景没有可导出的可见网格");
        }
        const result = await new GLTFExporter().parseAsync(exportRoot, {
          binary: true,
          onlyVisible: true,
          includeCustomExtensions: false,
          trs: true,
          animations
        });
        if (!(result instanceof ArrayBuffer)) throw new Error("GLB 导出器返回了非二进制结果");
        if (result.byteLength <= 1024) throw new Error("GLB 导出结果为空，请确认场景中存在可见模型网格");
        return result;
      } finally {
        for (const root of generatedFragmentRoots) this.disposeObject(root);
        this.updateCollisions(true);
      }
    }
  async exportSceneFbx(): Promise<string> {
      for (const model of this.models.values()) this.setCollisionHighlight(model, false);
      const exportRoot = new THREE.Group();
      exportRoot.name = "Deep Monkey Studio Scene";
      const generatedFragmentRoots: THREE.Group[] = [];
      let meshCount = 0;
      try {
        for (const model of this.models.values()) {
          if (!model.visible || !model.object.visible) continue;
          const fragmentsModel = this.fragmentModels.get(model.id);
          if (fragmentsModel) {
            const fragmentRoot = await this.buildFragmentsExportObject(model, fragmentsModel);
            const count = objectVisibleMeshCount(fragmentRoot);
            if (count > 0) {
              meshCount += count;
              generatedFragmentRoots.push(fragmentRoot);
              exportRoot.add(fragmentRoot);
            }
            continue;
          }
          const clone = model.object.clone(true);
          sanitizeExportObject(clone);
          meshCount += objectVisibleMeshCount(clone);
          exportRoot.add(clone);
        }
        if (meshCount === 0) throw new Error("当前场景没有可导出的可见网格");
        return exportFbxAscii(exportRoot);
      } finally {
        for (const root of generatedFragmentRoots) this.disposeObject(root);
        this.updateCollisions(true);
      }
    }
  protected async buildFragmentsExportObject(model: LoadedSceneModel, fragmentsModel: FRAGS.FragmentsModel, includeHidden = false): Promise<THREE.Group> {
      const root = new THREE.Group();
      root.name = model.name;
      root.position.copy(model.object.position);
      root.quaternion.copy(model.object.quaternion);
      root.scale.copy(model.object.scale);
      const material = new THREE.MeshStandardMaterial({ color: 0xbcc3c7, roughness: 0.78, metalness: 0.02 });
      const items = await fragmentsModel.getItemsWithGeometry();
      for (let index = 0; index < items.length; index += 1) {
        const geometryAccess = await items[index]!.getGeometry();
        if (!geometryAccess || (!includeHidden && !await geometryAccess.getVisibility())) continue;
        const meshData = await geometryAccess.get();
        for (const [partIndex, data] of meshData.entries()) {
          if (!data.positions || data.positions.length < 3) continue;
          const geometry = new THREE.BufferGeometry();
          const positions = data.positions instanceof Float32Array ? data.positions : new Float32Array(data.positions);
          geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          if (data.indices?.length) geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
          if (data.normals?.length === positions.length) {
            const normals = new Float32Array(data.normals.length);
            for (let normalIndex = 0; normalIndex < data.normals.length; normalIndex += 1) {
              normals[normalIndex] = Math.max(-1, data.normals[normalIndex]! / 32767);
            }
            geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
          } else {
            geometry.computeVertexNormals();
          }
          const mesh = new THREE.Mesh(geometry, material);
          mesh.name = `IFC ${data.localId ?? index}-${partIndex + 1}`;
          mesh.applyMatrix4(data.transform);
          root.add(mesh);
        }
        if (index > 0 && index % 100 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      if (root.children.length === 0) material.dispose();
      return root;
    }
}
