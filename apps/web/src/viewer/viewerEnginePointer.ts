import * as THREE from "three";
import type { ClippingState, MeasurementState, SceneAnnotationState, SceneInteractionTarget } from "@bim-studio/contracts";
import { closestPointsBetweenObjects, preciseIntersection, type CollisionRecord } from "./analysis";
import { constrainMeasurementEnd, elevationSegment, measurementAngle, projectRayToVerticalAxis } from "./measurement";
import { nearestBimElement } from "./bimMetadata";
import { primitiveGroundOffset, primitiveKindName } from "./primitiveGeometry";
import { toValue, visibleObjectBox } from "./sceneObjectUtils";
import { sameRuntimeInteractionTarget } from "./viewerStateUtils";
import { createAnnotationVisual, createMeasurementVisual, disposeViewerObject } from "./sceneOverlayVisuals";
import { type AnnotationPointerHit, type InteractionEventDetail, type LoadedSceneModel } from "./viewerTypes";
import { type PointerSceneHit } from "./viewerEngineTypes";
import { ViewerEngineObjectState } from "./viewerEngineObjectState";
import { createOrdinaryPicking } from "./ordinaryPicking";
import { xrControllerRay, xrHitModelId } from "./xrInput";

/** Pointer 职责层。 */
export abstract class ViewerEnginePointer extends ViewerEngineObjectState {
  protected readonly ordinaryPicking = createOrdinaryPicking(this);

  setPickingAccelerationEnabled(enabled: boolean): void { this.ordinaryPicking.setEnabled(enabled); }

  getPickingAccelerationDiagnostics() { return this.ordinaryPicking.diagnostics(); }

  /** XR 控制器 select/squeeze → 既有选择命令与交互总线（复用 WebXRManager 转发的事件，不造第二套输入）。 */
  protected override onXRControllerCreated(controller: THREE.Group): void {
      // getController 返回的 XRTargetRaySpace 会派发 selectstart/squeezestart；
      // three 的 Object3DEventMap 未收录这两个事件名，这里按 WebXR 合同窄化。
      const targetRay = controller as unknown as {
        addEventListener(type: "selectstart" | "squeezestart", listener: () => void): void;
      };
      targetRay.addEventListener("selectstart", () => this.handleXRControllerSelect(controller));
      targetRay.addEventListener("squeezestart", () => this.handleXRControllerSelect(controller));
    }
  protected handleXRControllerSelect(controller: THREE.Group): void {
      if (!this.xrActive) return;
      const ray = xrControllerRay(controller.matrixWorld);
      this.raycaster.set(ray.origin, ray.direction);
      this.raycaster.near = 0;
      this.raycaster.far = Infinity;
      // 与 pointerHit 相同的排除口径：Fragments 模型走异步拾取，普通射线先排除。
      const excluded = new Set<THREE.Object3D>();
      for (const id of this.fragmentModels.keys()) {
        const object = this.models.get(id)?.object;
        if (object) excluded.add(object);
      }
      const hit = this.ordinaryPicking.intersectObjects(this.raycaster, this.visibleModelObjects(), excluded)[0];
      const modelId = xrHitModelId(hit?.object);
      const model = modelId ? this.models.get(modelId) : undefined;
      this.select(model && modelId ? modelId : undefined);
      if (model && modelId) this.dispatchInteraction("click", { kind: "object", modelId });
    }

  protected updateCollisions(force: boolean, now = performance.now()): void {
      // 未启用碰撞且没有待清理高亮时，不遍历全场景计算包围盒。
      if (!this.collisionEnabledIds.size && !this.collidingIds.size && !this.collisionRecords.length) return;
      if (!force && now - this.lastCollisionCheck < 300) return;
      this.lastCollisionCheck = now;
      const next = new Set<string>();
      const records: CollisionRecord[] = [];
      const visitedPairs = new Set<string>();
      const visibleModels = [...this.models.values()].filter((model) => model.visible && model.object.visible);
      const boxes = new Map(visibleModels.map((model) => [model.id, visibleObjectBox(model.object)]));
      for (const id of this.collisionEnabledIds) {
        const source = this.models.get(id);
        const ownBox = boxes.get(id);
        if (!source || !ownBox || ownBox.isEmpty()) continue;
        for (const other of visibleModels) {
          if (other.id === id) continue;
          const pairKey = [id, other.id].sort().join("|");
          if (visitedPairs.has(pairKey)) continue;
          visitedPairs.add(pairKey);
          const otherBox = boxes.get(other.id);
          if (!otherBox || otherBox.isEmpty() || !ownBox.intersectsBox(otherBox)) continue;
          let intersection;
          try {
            intersection = preciseIntersection(source.object, other.object);
          } catch {
            intersection = undefined;
          }
          if (!intersection) continue;
          next.add(id);
          if (this.collisionEnabledIds.has(other.id)) next.add(other.id);
          const sourceComponent = this.componentRecord(id, intersection.nodeIdA);
          const targetComponent = this.componentRecord(other.id, intersection.nodeIdB);
          records.push({
            id: `${pairKey}:${intersection.nodeIdA}:${intersection.nodeIdB}`,
            sourceModelId: id,
            sourceNodeId: intersection.nodeIdA,
            sourceName: sourceComponent?.name ?? source.name,
            targetModelId: other.id,
            targetNodeId: intersection.nodeIdB,
            targetName: targetComponent?.name ?? other.name,
            point: toValue(intersection.point)
          });
        }
      }
      const changed = next.size !== this.collidingIds.size
        || [...next].some((id) => !this.collidingIds.has(id))
        || records.map((item) => item.id).join("|") !== this.collisionRecords.map((item) => item.id).join("|");
      for (const model of visibleModels) this.setCollisionHighlight(model, next.has(model.id));
      this.collidingIds.clear();
      next.forEach((id) => this.collidingIds.add(id));
      this.collisionRecords = records;
      if (changed) this.onCollisionChange?.();
    }
  protected setCollisionHighlight(model: LoadedSceneModel, active: boolean): void {
      model.object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        if (active) {
          if (!this.collisionOriginalMaterials.has(mesh)) this.collisionOriginalMaterials.set(mesh, mesh.material);
          const original = this.collisionOriginalMaterials.get(mesh);
          mesh.material = Array.isArray(original) ? original.map(() => this.collisionMaterial) : this.collisionMaterial;
        } else {
          const original = this.collisionOriginalMaterials.get(mesh);
          if (!original) return;
          mesh.material = original;
          this.collisionOriginalMaterials.delete(mesh);
        }
      });
    }
  protected refreshAnnotationVisual(id: string): void {
      const current = this.annotations.get(id);
      if (!current) return;
      const state = structuredClone(current.state);
      this.disposeObject(current.object);
      const object = createAnnotationVisual(state, this.selectedAnnotationId === state.id, this.readOnlyMode);
      this.annotations.set(id, {
        state,
        object,
        ...(current.localAnchor ? { localAnchor: current.localAnchor.clone() } : {}),
      });
      this.scene.add(object);
    }
  protected updateMeasurementPreview(end: THREE.Vector3): void {
      const start = this.measurementPoints[0];
      if (!start) return;
      this.removeMeasurementPreview();
      const constrained = constrainMeasurementEnd(start, end, this.measureMode);
      const points = this.measureMode === "angle" && this.measurementPoints[1]
        ? [start, this.measurementPoints[1]!, constrained]
        : [start, constrained];
      const angle = this.measureMode === "angle" && points[2] ? measurementAngle(points[0]!, points[1]!, points[2]) : undefined;
      this.measurementPreview = createMeasurementVisual({
        id: "preview",
        start: toValue(points[0]!),
        end: toValue(points[1]!),
        distance: points[0]!.distanceTo(points[1]!),
        kind: this.measureMode,
        points: points.map(toValue),
        ...(angle === undefined ? {} : { angle })
      }, true);
      this.measurementPreview.name = "helper:measurement-preview";
      this.scene.add(this.measurementPreview);
    }
  protected measurementEnd(start: THREE.Vector3, hitPoint: THREE.Vector3): THREE.Vector3 {
      if (this.measureMode !== "vertical") return constrainMeasurementEnd(start, hitPoint, this.measureMode);
      return projectRayToVerticalAxis(this.raycaster.ray, start);
    }
  protected finishMeasurement(measurement: MeasurementState): void {
      this.removeMeasurementPreview();
      this.addMeasurementVisual(measurement);
      this.onMeasurement?.(measurement);
      this.measurementPoints.length = 0;
      this.measurementTargets.length = 0;
      this.onMeasurementDraftChange?.(false, 0, 0);
    }
  protected removeMeasurementPreview(): void {
      if (!this.measurementPreview) return;
      this.disposeObject(this.measurementPreview);
      this.measurementPreview = undefined;
    }
  protected disposeObject(object: THREE.Object3D): void {
      if (this.rendererBackend === "webgpu" && !this.rendererDisposalStarted) {
        object.removeFromParent();
        this.gpuResourceRetirementQueue.retire(() => disposeViewerObject(object));
        return;
      }
      disposeViewerObject(object);
    }
  protected pointerHit(event: PointerEvent, editableOnly = false): THREE.Intersection | undefined {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointerPosition.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      this.raycaster.setFromCamera(this.pointerPosition, this.camera);
      const excluded = new Set<THREE.Object3D>();
      for (const id of this.fragmentModels.keys()) {
        const object = this.models.get(id)?.object;
        if (object) excluded.add(object);
      }
      return this.ordinaryPicking.intersectObjects(this.raycaster, this.visibleModelObjects(), excluded).find(hit => {
        if (!editableOnly) return true;
        const modelId = xrHitModelId(hit.object);
        for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) {
          if (object.userData.layerLocked) return false;
        }
        return !modelId || !this.isLayerLocked(modelId, String(hit.object.userData.layerNodeId ?? "root"));
      });
    }
  protected annotationPointerHit(event: PointerEvent, editableOnly = false): AnnotationPointerHit | undefined {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointerPosition.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      this.raycaster.setFromCamera(this.pointerPosition, this.camera);
      const roots = [...this.annotations.values()].filter(({ state }) => state.visible && (!editableOnly || !state.locked)).map(({ object }) => object);
      const hit = this.raycaster.intersectObjects(roots, true)[0];
      const object = hit?.object;
      const annotationId = object?.userData.annotationId;
      if (!hit || !object || typeof annotationId !== "string") return undefined;
      return {
        annotationId,
        // Sprite UV 原点在左下；关闭图标位于标签右上角。
        dismiss: object.userData.dismissible === true && Boolean(hit.uv && hit.uv.x >= 0.88 && hit.uv.y >= 0.5),
      };
    }
  protected async scenePointerHit(event: PointerEvent, editableOnly = false): Promise<PointerSceneHit | undefined> {
      const ordinary = this.pointerHit(event, editableOnly);
      const ordinaryModelId = ordinary?.object.userData.modelId as string | undefined;
      let best: PointerSceneHit | undefined = ordinary ? {
        point: ordinary.point.clone(),
        distance: ordinary.distance,
        objectName: ordinary.object.name || ordinary.object.type,
        object: ordinary.object,
        ...(ordinary.face ? { normal: ordinary.face.normal.clone().transformDirection(ordinary.object.matrixWorld) } : {}),
        ...(ordinaryModelId ? { modelId: ordinaryModelId } : {})
      } : undefined;
      const mouse = new THREE.Vector2(event.clientX, event.clientY);
      for (const [modelId, fragmentsModel] of this.fragmentModels) {
        if (!this.models.get(modelId)?.visible) continue;
        if (editableOnly && this.isModelLocked(modelId)) continue;
        const query = { camera: this.camera, mouse, dom: this.renderer.domElement };
        const hit = editableOnly
          ? (await fragmentsModel.raycastAll(query))?.filter(candidate => {
            const nodeId = this.fragmentNodeIdsByLocalId.get(modelId)?.get(candidate.localId)
              ?? this.ensureFragmentEntry(modelId, candidate.localId);
            return !nodeId || !this.isLayerLocked(modelId, nodeId);
          }).sort((a, b) => a.distance - b.distance)[0]
          : await fragmentsModel.raycast(query);
        if (!hit || (best && best.distance <= hit.distance && ordinaryModelId !== modelId)) continue;
        const fragmentNodeId = this.fragmentNodeIdsByLocalId.get(modelId)?.get(hit.localId)
          ?? this.ensureFragmentEntry(modelId, hit.localId);
        const entry = fragmentNodeId ? this.fragmentLayers.get(modelId)?.get(fragmentNodeId) : undefined;
        best = {
          point: hit.point.clone(),
          distance: hit.distance,
          objectName: entry?.node.name || `IFC 构件 ${hit.localId}`,
          object: hit.object,
          ...(hit.normal ? { normal: hit.normal.clone() } : {}),
          modelId,
          ...(fragmentNodeId ? { fragmentNodeId } : {})
        };
      }
      if (!best && (this.measureEnabled || this.annotationPlacementEnabled || this.primitivePlacementKind)) {
        const point = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
        if (point) best = { point, distance: this.camera.position.distanceTo(point), objectName: "地面" };
      }
      return best;
    }
  protected interactionTargetFromHit(hit: PointerSceneHit | undefined): SceneInteractionTarget | undefined {
      if (!hit?.modelId) return undefined;
      const rawLayerId = hit.fragmentNodeId ?? hit.object?.userData.layerNodeId;
      const layerId = typeof rawLayerId === "string" && rawLayerId !== "root" ? rawLayerId : undefined;
      return { kind: "object", modelId: hit.modelId, ...(layerId ? { layerId } : {}) };
    }
  protected interactionTargetHierarchy(target: SceneInteractionTarget | undefined): SceneInteractionTarget[] {
      if (!target || target.kind !== "object") return target ? [target] : [];
      return target.layerId
        ? [{ kind: "object", modelId: target.modelId }, target]
        : [target];
    }
  protected updateHoverInteraction(hit: PointerSceneHit | undefined, event: PointerEvent): void {
      const next = this.interactionTargetHierarchy(this.interactionTargetFromHit(hit));
      for (const previousTarget of this.hoverInteractionTargets) {
        if (!next.some((target) => sameRuntimeInteractionTarget(target, previousTarget))) {
          this.dispatchExactInteraction("pointerLeave", previousTarget, { originalEvent: event });
        }
      }
      for (const nextTarget of next) {
        if (!this.hoverInteractionTargets.some((target) => sameRuntimeInteractionTarget(target, nextTarget))) {
          this.dispatchExactInteraction("pointerEnter", nextTarget, { originalEvent: event, ...(hit ? { point: hit.point, object: hit.object } : {}) });
        }
      }
      this.hoverInteractionTargets = next;
    }
  protected handlePointerMove = async (event: PointerEvent): Promise<void> => {
      if (this.transform.dragging) return;
      const hasHoverEvents = this.interactionScripts.some((script) => script.enabled && (script.trigger === "pointerEnter" || script.trigger === "pointerLeave"));
      if (!this.onPointerInfoChange && !(this.measureEnabled && this.measurementPoints.length > 0) && !hasHoverEvents) return;
      if (hasHoverEvents && !this.onPointerInfoChange && performance.now() - this.lastInteractionHoverCheck < 48) return;
      this.lastInteractionHoverCheck = performance.now();
      const sequence = ++this.pointerMoveSequence;
      const hit = await this.scenePointerHit(event);
      if (sequence !== this.pointerMoveSequence) return;
      if (hasHoverEvents) this.updateHoverInteraction(hit, event);
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.onPointerInfoChange?.({
        screenX: Math.round(event.clientX - rect.left),
        screenY: Math.round(event.clientY - rect.top),
        ...(hit ? { world: toValue(hit.point), objectName: hit.objectName } : {})
      });
      if (this.measureEnabled && this.measurementPoints.length > 0 && hit) {
        this.updateMeasurementPreview(this.measurementEnd(this.measurementPoints[0]!, hit.point));
      }
    };
  protected handlePointerLeave = (): void => {
      this.pointerMoveSequence += 1;
      for (const target of this.hoverInteractionTargets) this.dispatchExactInteraction("pointerLeave", target);
      this.hoverInteractionTargets = [];
      if (this.measurementPoints.length > 0) this.removeMeasurementPreview();
      this.onPointerInfoChange?.(undefined);
    };
  protected handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      void this.dispatchPointerInteraction("contextMenu", event);
    };
  protected handleDoubleClick = (event: MouseEvent): void => {
      if (this.navigationMode === "firstPerson" && !this.pointer.isLocked) this.pointer.lock();
      void this.dispatchPointerInteraction("doubleClick", event);
    };
  protected async dispatchPointerInteraction(trigger: "doubleClick" | "contextMenu", event: MouseEvent): Promise<void> {
      const hit = await this.scenePointerHit(event as PointerEvent);
      const target = this.interactionTargetFromHit(hit);
      if (!target) return;
      this.dispatchInteraction(trigger, target, { originalEvent: event, ...(hit ? { point: hit.point, ...(hit.object ? { object: hit.object } : {}) } : {}) });
    }
  protected handlePointerDown = async (event: PointerEvent): Promise<void> => {
      void this.unlockSpatialAudio();
      if (this.navigationMode === "firstPerson") return;
      if (event.button !== 0) return;
      if (this.transform.dragging || this.transform.axis) return;
      if (!this.measureEnabled && !this.annotationPlacementEnabled && !(this.clippingState.enabled && this.clippingState.mode === "face")) {
        const lightHit = this.lightProxyPointerHit(event);
        if (lightHit && this.selectSceneLight(lightHit.id, lightHit.handle)) return;
      }
      const editableOnly = !this.readOnlyMode && !this.measureEnabled && !this.annotationPlacementEnabled
        && !this.primitivePlacementKind && !(this.clippingState.enabled && this.clippingState.mode === "face");
      const hit = await this.scenePointerHit(event, editableOnly);
      if (this.primitivePlacementKind) {
        if (!hit) return;
        const kind = this.primitivePlacementKind;
        const color = "#d4a84f";
        const position = hit.point.clone();
        position.y += primitiveGroundOffset(kind);
        const index = [...this.models.values()].filter((item) => item.kind === "primitive").length + 1;
        const model = this.createPrimitive(crypto.randomUUID(), `${primitiveKindName(kind)} ${index}`, kind, color, position);
        this.cancelPrimitivePlacement();
        this.onPrimitivePlaced?.(model, kind, color);
        return;
      }
      if (this.annotationPlacementEnabled) {
        if (!hit) return;
        const annotation: SceneAnnotationState = {
          id: crypto.randomUUID(),
          name: `标签 ${this.annotations.size + 1}`,
          description: hit.objectName,
          position: toValue(hit.point),
          color: "#2f8fff",
          visible: true,
          locked: false,
          size: 1,
          ...(hit.modelId ? { modelId: hit.modelId } : {}),
          ...(hit.fragmentNodeId ? { layerId: hit.fragmentNodeId } : hit.object?.userData.layerNodeId ? { layerId: String(hit.object.userData.layerNodeId) } : {}),
          anchorName: hit.objectName
        };
        this.addAnnotation(annotation);
        this.selectAnnotation(annotation.id);
        this.onAnnotationPlaced?.(structuredClone(annotation));
        return;
      }
      if (this.clippingState.enabled && this.clippingState.mode === "face" && !this.clippingState.face) {
        if (!hit?.normal) return;
        const next: ClippingState = {
          ...this.clippingState,
          face: { normal: toValue(hit.normal.clone().normalize()), point: toValue(hit.point) }
        };
        this.setClipping(next);
        this.onClippingFacePicked?.(next);
        return;
      }
      if (this.measureEnabled) {
        if (!hit) return;
        if (this.measureMode === "elevation") {
          const [start, end] = elevationSegment(hit.point);
          this.finishMeasurement({
            id: crypto.randomUUID(),
            start: toValue(start),
            end: toValue(end),
            distance: start.distanceTo(end),
            elevation: hit.point.y,
            kind: "elevation",
            points: [toValue(start), toValue(end)],
            labels: [hit.objectName]
          });
          return;
        }
        if (this.measureMode === "minimum") {
          const model = hit.modelId ? this.models.get(hit.modelId) : undefined;
          const object = hit.object ? nearestBimElement(hit.object, model?.object) ?? hit.object : undefined;
          this.measurementTargets.push({ point: hit.point.clone(), ...(object ? { object } : {}), label: hit.objectName });
          this.measurementPoints.push(hit.point.clone());
          if (this.measurementTargets.length === 1) {
            this.onMeasurementDraftChange?.(true, 1, 2);
            return;
          }
          const [first, second] = this.measurementTargets;
          const closest = first?.object && second?.object && first.object !== second.object
            ? closestPointsBetweenObjects(first.object, second.object)
            : undefined;
          const start = closest?.pointA ?? first!.point;
          const end = closest?.pointB ?? second!.point;
          this.finishMeasurement({
            id: crypto.randomUUID(),
            start: toValue(start),
            end: toValue(end),
            distance: start.distanceTo(end),
            kind: "minimum",
            points: [toValue(start), toValue(end)],
            labels: [first?.label ?? "对象 A", second?.label ?? "对象 B"]
          });
          return;
        }
        const point = this.measurementPoints.length === 1
          ? this.measurementEnd(this.measurementPoints[0]!, hit.point)
          : hit.point.clone();
        this.measurementPoints.push(point);
        const requiredPoints = this.measureMode === "angle" ? 3 : 2;
        this.onMeasurementDraftChange?.(this.measurementPoints.length < requiredPoints, this.measurementPoints.length, requiredPoints);
        if (this.measurementPoints.length === requiredPoints) {
          const start = this.measurementPoints[0]!;
          const end = this.measurementPoints[1]!;
          const measurement: MeasurementState = {
            id: crypto.randomUUID(),
            start: toValue(start),
            end: toValue(end),
            distance: start.distanceTo(end),
            kind: this.measureMode,
            points: this.measurementPoints.map(toValue),
            ...(this.measureMode === "angle" ? { angle: measurementAngle(start, end, this.measurementPoints[2]!) } : {})
          };
          this.finishMeasurement(measurement);
        }
        return;
      }
      const annotationHit = this.annotationPointerHit(event, editableOnly);
      if (annotationHit) {
        if (annotationHit.dismiss) {
          const dismissed = this.updateAnnotation(annotationHit.annotationId, { visible: false });
          if (dismissed) this.onAnnotationChange?.(dismissed);
          this.selectAnnotation(undefined);
          return;
        }
        this.selectAnnotation(annotationHit.annotationId);
        const annotation = this.annotations.get(annotationHit.annotationId)?.state;
        if (annotation?.modelId) {
          const target: SceneInteractionTarget = {
            kind: "object",
            modelId: annotation.modelId,
            ...(annotation.layerId ? { layerId: annotation.layerId } : {}),
          };
          this.dispatchInteraction("click", target, {
            originalEvent: event,
            payload: { source: "annotation", annotationId: annotationHit.annotationId },
          });
        }
        return;
      }
      const interactionTarget = this.interactionTargetFromHit(hit);
      const interactionDetail: InteractionEventDetail = { originalEvent: event, ...(hit ? { point: hit.point, ...(hit.object ? { object: hit.object } : {}) } : {}) };
      if (hit?.modelId && this.selectionScope === "model") {
        this.select(hit.modelId);
        if (interactionTarget) this.dispatchInteraction("click", interactionTarget, interactionDetail);
        return;
      }
      if (hit?.modelId && hit.fragmentNodeId) {
        this.selectLayer(hit.modelId, hit.fragmentNodeId);
        if (interactionTarget) this.dispatchInteraction("click", interactionTarget, interactionDetail);
        return;
      }
      const id = hit?.modelId;
      if (!hit?.object) {
        this.select(id);
        if (interactionTarget) this.dispatchInteraction("click", interactionTarget, interactionDetail);
        return;
      }
      this.selectedId = id;
      this.selectedFragmentNodeId = undefined;
      const model = id ? this.models.get(id) : undefined;
      this.inspectedObject = nearestBimElement(hit.object, model?.object) ?? hit.object;
      this.updatePostProcessingSelection();
      if (!model || !this.inspectedObject) this.transform.detach();
      this.updateTransformAccess();
      this.updateSelectionHelper();
      this.onSelectionChange?.(model);
      if (interactionTarget) this.dispatchInteraction("click", interactionTarget, interactionDetail);
    };
  protected handleKeyDown = (event: KeyboardEvent): void => {
      this.keys.add(event.code);
      if (event.code === "Escape") {
        if (this.xrActive) {
          void this.endXR();
          return;
        }
        if (this.primitivePlacementKind) {
          this.cancelPrimitivePlacement();
          return;
        }
        if (this.measurementPoints.length > 0) {
          this.measurementPoints.length = 0;
          this.measurementTargets.length = 0;
          this.removeMeasurementPreview();
          this.onMeasurementDraftChange?.(false);
        } else {
          this.select(undefined);
        }
      }
      if (event.code === "Space" && this.navigationMode === "firstPerson" && !event.repeat) {
        this.firstPersonJumpRequested = true;
        event.preventDefault();
      }
    };
  protected handleKeyUp = (event: KeyboardEvent): void => {
      this.keys.delete(event.code);
    };
}
