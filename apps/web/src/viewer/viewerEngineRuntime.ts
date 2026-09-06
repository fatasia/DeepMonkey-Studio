import * as THREE from "three";
import { isWalkableSurface, slideAgainstSurface } from "./characterMotion";
import { visibleObjectBox } from "./sceneObjectUtils";
import { type NavigationMode } from "./viewerTypes";
import { type NavigationViewState } from "./viewerEngineTypes";
import { ViewerEngineRuntimeSupport } from "./viewerEngineRuntimeSupport";
import { updateAnnotationVisualPresentation } from "./sceneOverlayVisuals";
import { visibleAnnotationLabelIds } from "./annotationLabelLayout";
import { nextFrameCadence } from "./viewerFrameCadence";
import { resolveOrbitCameraRange } from "./cameraFraming";
import { sceneGridCloseupOpacity } from "./sceneGrid";

const READ_ONLY_TARGET_FPS = 60;

/** Runtime 职责层。 */
export abstract class ViewerEngineRuntime extends ViewerEngineRuntimeSupport {
  protected animate = (): void => {
    if (!this.xrActive) this.animationFrame = requestAnimationFrame(this.animate);
    const now = performance.now();
    if (!this.xrActive && document.visibilityState !== "visible") {
      this.lastFrameTime = now;
      this.readOnlyFrameCadenceAnchor = undefined;
      return;
    }
    if (!this.xrActive && this.readOnlyMode) {
      const cadence = nextFrameCadence(now, this.readOnlyFrameCadenceAnchor, READ_ONLY_TARGET_FPS);
      this.readOnlyFrameCadenceAnchor = cadence.anchorMs;
      if (!cadence.render) return;
    } else {
      this.readOnlyFrameCadenceAnchor = undefined;
    }
    this.framePerformanceMonitor.recordFrame(now, document.visibilityState === "visible");
    const delta = Math.min((now - this.lastFrameTime) / 1000, 0.05);
    this.lastFrameTime = now;
    if (this.adaptiveQualityEnabled && now - this.lastAdaptiveRenderSampleAt >= 500) {
      this.lastAdaptiveRenderSampleAt = now;
      const performanceSnapshot = this.framePerformanceMonitor.snapshot(this.readRendererLoad(), undefined, this.longTaskMonitor.snapshot(now));
      const nextPixelRatio = this.adaptiveRenderScaleController.sample({
        sampleCount: performanceSnapshot.sampleCount,
        p95FrameMs: performanceSnapshot.frameTimeMs.p95,
        visible: document.visibilityState === "visible",
      });
      if (nextPixelRatio !== undefined) {
        this.applyRendererPixelRatio(nextPixelRatio);
        // 比例变化后重新采样，避免旧窗口连续触发降档或延迟恢复。
        this.framePerformanceMonitor.reset();
      }
    }
    this.mixers.forEach((mixer) => mixer.update(delta));
    this.updateCompletedModelAnimations();
    if (this.sceneAnimationPlaying) {
      const speed = this.sceneAnimation.playbackSpeed ?? 1;
      this.sceneAnimationTime += delta * speed * this.sceneAnimationDirection;
      if (this.sceneAnimationTime >= this.sceneAnimation.duration || this.sceneAnimationTime <= 0) {
        if (this.sceneAnimation.pingPong) {
          this.sceneAnimationTime = THREE.MathUtils.clamp(this.sceneAnimationTime, 0, this.sceneAnimation.duration);
          this.sceneAnimationDirection *= -1;
          if (!this.sceneAnimation.loop && this.sceneAnimationDirection > 0) this.pauseSceneAnimation();
        } else if (this.sceneAnimation.loop) {
          this.sceneAnimationTime = (this.sceneAnimationTime + this.sceneAnimation.duration) % this.sceneAnimation.duration;
        } else {
          this.sceneAnimationTime = this.sceneAnimationDirection > 0 ? this.sceneAnimation.duration : 0;
          this.pauseSceneAnimation();
        }
      }
      this.applySceneAnimationFrame(this.sceneAnimationTime);
      if (now - this.lastAnimationNotify > 80 || !this.sceneAnimationPlaying) {
        this.lastAnimationNotify = now;
        this.onAnimationChange?.(this.sceneAnimationTime, this.sceneAnimationPlaying);
      }
    } else {
      this.updateNavigation(delta);
    }
    this.updateModelRig();
    this.updateXRLocomotion(delta);
    this.updatePhysics(delta);
    this.updateModelEffects(delta);
    this.updateMaterialUvAnimations(delta);
    this.updateIndustrialMotionRoutes(delta);
    this.updateAnnotationLabels();
    this.updateWeather(delta);
    this.updateCollisions(false, now);
    this.updateNavigationCollisionDebug(now);
    this.syncSpaceVisuals();
    this.updateSceneLightProxies();
    this.applyShadowUpdatePolicy();
    if (this.navigationMode !== "firstPerson") {
      this.orbit.update();
      this.enforceCameraCollision(now);
    }
    if (this.gridHelper && this.gridHelper.material instanceof THREE.MeshBasicMaterial) {
      this.gridHelper.material.opacity = this.navigationMode === "orbit"
        ? sceneGridCloseupOpacity(this.camera.position.distanceTo(this.orbit.target)) : 1;
    }
    this.emitCameraChange();
    this.renderer.info.reset();
    if (!this.xrActive && this.needsPostProcessing() && this.postProcessing) this.postProcessing.render(delta);
    else this.renderer.render(this.scene, this.camera);
    this.gpuFrameTimeMonitor.onFrameRendered();
  };
  private updateAnnotationLabels(): void {
    this.syncAnnotationAnchors();
    const viewportWidth = Math.max(this.container.clientWidth, 1);
    const viewportHeight = Math.max(this.container.clientHeight, 1);
    const presentations = [];
    for (const [id, annotation] of this.annotations) {
      const presentation = updateAnnotationVisualPresentation(
        id,
        annotation.object,
        this.camera,
        viewportWidth,
        viewportHeight,
        id === this.selectedAnnotationId,
      );
      if (presentation) presentations.push(presentation);
    }
    const visibleIds = visibleAnnotationLabelIds(
      presentations.map((presentation) => presentation.candidate),
      viewportWidth,
      viewportHeight,
    );
    presentations.forEach(({ sprite, candidate }) => { sprite.visible = visibleIds.has(candidate.id); });
  }
  protected updateNavigation(delta: number): void {
    if (this.navigationMode === "firstPerson" && this.pointer.isLocked) {
      const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      const speed = this.navigationSettings.walkSpeed * (sprint ? this.navigationSettings.sprintMultiplier : 1) * delta;
      const input = new THREE.Vector2(Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA")), Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS")));
      if (input.lengthSq() > 0) {
        input.normalize();
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
        const movement = forward.multiplyScalar(input.y).add(right.multiplyScalar(input.x)).multiplyScalar(speed);
        this.camera.position.add(this.resolveCharacterMovement(movement, this.camera.position, this.navigationSettings.eyeHeight));
      }
      const floor = this.findFloorHeight(this.camera.position);
      if (floor !== undefined) {
        const targetY = floor + this.navigationSettings.eyeHeight;
        this.firstPersonGrounded = this.camera.position.y <= targetY + 0.08 && this.firstPersonVelocity.y <= 0;
        if (this.firstPersonJumpRequested && this.firstPersonGrounded) {
          this.firstPersonVelocity.y = this.navigationSettings.jumpSpeed;
          this.firstPersonGrounded = false;
        }
        this.firstPersonJumpRequested = false;
        if (!this.firstPersonGrounded || this.firstPersonVelocity.y > 0) {
          this.firstPersonVelocity.y -= this.navigationSettings.gravity * delta;
          this.camera.position.y += this.firstPersonVelocity.y * delta;
          if (this.camera.position.y <= targetY) {
            this.camera.position.y = targetY;
            this.firstPersonVelocity.y = 0;
            this.firstPersonGrounded = true;
          }
        } else {
          this.camera.position.y += (targetY - this.camera.position.y) * Math.min(delta * 10, 1);
        }
      } else {
        this.firstPersonJumpRequested = false;
      }
      return;
    }
    if (this.navigationMode !== "thirdPerson" || !this.avatar) return;
    const input = new THREE.Vector3(
      Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA")),
      Number(this.keys.has("Space")) - Number(this.keys.has("ControlLeft") || this.keys.has("ControlRight")),
      Number(this.keys.has("KeyS")) - Number(this.keys.has("KeyW")),
    );
    const target = this.avatar.position.clone().add(new THREE.Vector3(0, 1.25, 0));
    this.orbit.target.lerp(target, Math.min(delta * 12, 1));
    if (input.lengthSq() === 0) return;
    const sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    input.normalize().multiplyScalar(this.navigationSettings.flySpeed * (sprint ? this.navigationSettings.sprintMultiplier : 1) * delta);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const movement = right
      .multiplyScalar(input.x)
      .add(forward.multiplyScalar(-input.z))
      .add(new THREE.Vector3(0, input.y, 0));
    const resolvedMovement = this.resolveCharacterMovement(movement, this.avatar.position.clone().add(new THREE.Vector3(0, 1.75, 0)), 1.75);
    if (resolvedMovement.lengthSq() === 0) return;
    this.avatar.position.add(resolvedMovement);
    this.camera.position.add(resolvedMovement);
    this.orbit.target.add(resolvedMovement);
    if (resolvedMovement.lengthSq() > 0) {
      this.avatarHeading.lerp(resolvedMovement.clone().normalize(), Math.min(delta * 12, 1)).normalize();
      this.avatar.rotation.y = Math.atan2(this.avatarHeading.x, this.avatarHeading.z);
    }
  }
  protected configureNavigationControls(mode: NavigationMode): void {
    this.camera.up.set(0, 1, 0);
    this.orbit.enabled = mode !== "firstPerson";
    if (mode === "thirdPerson") {
      this.orbit.minDistance = Math.max(2.2, this.cameraConstraints.minDistance);
      this.orbit.maxDistance = Math.max(this.orbit.minDistance, Math.min(12, this.cameraConstraints.maxDistance));
      this.orbit.minPolarAngle = THREE.MathUtils.degToRad(this.cameraConstraints.minPolarAngle);
      this.orbit.maxPolarAngle = Math.min(Math.PI * 0.48, THREE.MathUtils.degToRad(this.cameraConstraints.maxPolarAngle));
    } else {
      const range = mode === "orbit"
        ? resolveOrbitCameraRange(this.cameraConstraints, this.camera.position.distanceTo(this.orbit.target)) : this.cameraConstraints;
      this.orbit.minDistance = range.minDistance;
      this.orbit.maxDistance = range.maxDistance;
      this.orbit.minPolarAngle = THREE.MathUtils.degToRad(this.cameraConstraints.minPolarAngle);
      this.orbit.maxPolarAngle = THREE.MathUtils.degToRad(this.cameraConstraints.maxPolarAngle);
    }
    this.applyCameraClippingRange();
    this.updateTransformAccess();
  }
  protected captureNavigationState(mode: NavigationMode): NavigationViewState {
    const position = this.camera.position.clone();
    let target = this.orbit.target.clone();
    if (mode === "firstPerson") {
      const direction = new THREE.Vector3();
      this.camera.getWorldDirection(direction);
      if (direction.lengthSq() > 1e-10) target = position.clone().add(direction.normalize().multiplyScalar(5));
    }
    return { position, target };
  }
  protected rememberNavigationState(mode: NavigationMode): void {
    const state = this.captureNavigationState(mode);
    if (this.isNavigationStateUsable(state)) this.navigationViewStates.set(mode, state);
  }
  protected applyNavigationViewState(state: NavigationViewState): void {
    this.camera.position.copy(state.position);
    this.orbit.target.copy(state.target);
    if (this.navigationMode === "thirdPerson") {
      this.ensureAvatar();
      this.avatar?.position.copy(state.target).add(new THREE.Vector3(0, -1.25, 0));
    }
    this.camera.lookAt(state.target);
    this.orbit.update();
  }
  protected isNavigationStateUsable(state: NavigationViewState): boolean {
    const values = [...state.position.toArray(), ...state.target.toArray()];
    if (values.some((value) => !Number.isFinite(value))) return false;
    if (state.position.distanceToSquared(state.target) < 1e-8) return false;
    const bounds = this.sceneContentBox();
    if (bounds.isEmpty()) return true;
    const size = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1);
    const allowed = bounds.clone().expandByScalar(Math.max(size * 24, 120));
    return allowed.containsPoint(state.position) && allowed.containsPoint(state.target);
  }
  protected navigationAnchor(previousMode: NavigationMode): THREE.Vector3 {
    const bounds = this.sceneContentBox();
    const candidate =
      previousMode === "firstPerson" ? this.camera.position.clone() : previousMode === "thirdPerson" && this.avatar ? this.avatar.position.clone() : this.orbit.target.clone();
    if (bounds.isEmpty()) return candidate.toArray().every(Number.isFinite) ? candidate : new THREE.Vector3();
    const padded = bounds.clone().expandByScalar(Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.2, 2));
    if (!candidate.toArray().every(Number.isFinite)) return bounds.getCenter(new THREE.Vector3());
    return padded.clampPoint(candidate, new THREE.Vector3());
  }
  protected recoverNavigationMode(mode: NavigationMode): void {
    const anchor = this.navigationAnchor(mode);
    if (mode === "orbit") this.frameScene();
    else if (mode === "firstPerson") this.enterFirstPerson(anchor);
    else this.enterThirdPerson(anchor);
  }
  protected enterFirstPerson(anchor: THREE.Vector3): void {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() === 0) forward.set(0, 0, -1);
    forward.normalize();
    const start = anchor.clone();
    const floor = this.findFloorHeight(start.clone().add(new THREE.Vector3(0, 10, 0))) ?? 0;
    start.y = floor + this.navigationSettings.eyeHeight;
    const recoveredStart = this.recoverCharacterSpawn(start, this.navigationSettings.eyeHeight);
    if (!recoveredStart.equals(start)) this.onNavigationRecovery?.();
    this.firstPersonVelocity.set(0, 0, 0);
    this.firstPersonGrounded = true;
    this.firstPersonJumpRequested = false;
    this.camera.position.copy(recoveredStart);
    this.orbit.target.copy(recoveredStart).add(forward.multiplyScalar(5));
    this.camera.lookAt(this.orbit.target);
  }
  protected enterThirdPerson(anchor: THREE.Vector3): void {
    this.ensureAvatar();
    if (!this.avatar) return;
    const floor = this.findFloorHeight(anchor.clone().add(new THREE.Vector3(0, 10, 0))) ?? 0;
    this.avatar.position.set(anchor.x, Math.max(anchor.y, floor + 6), anchor.z);
    const target = this.avatar.position.clone().add(new THREE.Vector3(0, 1.25, 0));
    const direction = this.camera.position.clone().sub(anchor).setY(0).normalize();
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    this.orbit.target.copy(target);
    this.camera.position
      .copy(target)
      .add(direction.multiplyScalar(5))
      .add(new THREE.Vector3(0, 2.4, 0));
    this.orbit.update();
    this.resetCameraCollisionAnchor();
  }
  protected ensureAvatar(): void {
    if (this.avatar) return;
    const group = new THREE.Group();
    group.name = "helper:avatar";
    const material = new THREE.MeshStandardMaterial({ color: 0xe0a93d, roughness: 0.72 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.72, 6, 10), material);
    body.position.y = 1.02;
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), material);
    head.position.y = 1.62;
    group.add(head);
    const limbGeometry = new THREE.CapsuleGeometry(0.08, 0.58, 4, 8);
    for (const x of [-0.14, 0.14]) {
      const leg = new THREE.Mesh(limbGeometry, material);
      leg.position.set(x, 0.42, 0);
      group.add(leg);
    }
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.12, 0.18), material);
    shoulder.position.y = 1.28;
    group.add(shoulder);
    this.scene.add(group);
    this.avatar = group;
    group.visible = this.avatarVisible && this.navigationMode === "thirdPerson";
  }
  protected visibleModelObjects(): THREE.Object3D[] {
    return [...this.models.values()].filter((model) => model.visible).map((model) => model.object);
  }
  protected findFloorHeight(position: THREE.Vector3): number | undefined {
    const origin = position.clone().add(new THREE.Vector3(0, 2, 0));
    this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
    this.raycaster.near = 0;
    this.raycaster.far = 20;
    const hit = this.raycaster.intersectObjects(this.visibleModelObjects(), true).find((item) => {
      if (item.point.y > position.y + 2.05) return false;
      if (!item.face) return true;
      const normal = item.face.normal.clone().transformDirection(item.object.matrixWorld);
      return isWalkableSurface(normal, this.camera.up, this.navigationSettings.maxSlopeAngle);
    });
    this.raycaster.far = Infinity;
    return hit?.point.y ?? (position.y >= -2 && position.y <= 12 ? 0 : undefined);
  }
  protected applyCameraClippingRange(): void {
    const range = this.navigationMode === "orbit"
      ? resolveOrbitCameraRange(this.cameraConstraints, this.camera.position.distanceTo(this.orbit.target)) : this.cameraConstraints;
    this.camera.near = range.nearClip;
    this.camera.far = range.farClip;
    this.camera.updateProjectionMatrix();
  }
  protected resetCameraCollisionAnchor(): void {
    this.cameraCollisionAnchor.copy(this.camera.position);
    this.cameraCollisionDirty = false;
  }
  protected enforceCameraCollision(now: number): void {
    if (!this.cameraConstraints.collisionEnabled) {
      this.resetCameraCollisionAnchor();
      return;
    }
    if (!this.cameraCollisionDirty || now - this.lastCameraCollisionCheck < 80) return;
    this.lastCameraCollisionCheck = now;
    const movement = this.camera.position.clone().sub(this.cameraCollisionAnchor);
    const distance = movement.length();
    if (distance < 0.0001) {
      this.cameraCollisionDirty = false;
      return;
    }
    const direction = movement.multiplyScalar(1 / distance);
    this.raycaster.set(this.cameraCollisionAnchor, direction);
    this.raycaster.near = 0.01;
    this.raycaster.far = distance + this.cameraConstraints.collisionRadius;
    const hit = this.raycaster.intersectObjects(this.visibleModelObjects(), true).find((item) => item.distance <= distance + this.cameraConstraints.collisionRadius);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    if (hit) {
      const allowedDistance = Math.max(0, hit.distance - this.cameraConstraints.collisionRadius);
      this.camera.position.copy(this.cameraCollisionAnchor).addScaledVector(direction, allowedDistance);
      this.orbit.update();
    }
    this.cameraCollisionAnchor.copy(this.camera.position);
    this.cameraCollisionDirty = false;
  }
  protected resolveCharacterMovement(movement: THREE.Vector3, topOrigin: THREE.Vector3, height: number): THREE.Vector3 {
    if (!this.cameraConstraints.collisionEnabled || movement.lengthSq() === 0) return movement.clone();
    const sweepStartedAt = performance.now();
    this.navigationRaySamples = 0;
    const resolved = new THREE.Vector3();
    const currentOrigin = topOrigin.clone();
    let remaining = movement.clone();
    let stepped = false;
    for (let pass = 0; pass < 3 && remaining.lengthSq() > 1e-10; pass += 1) {
      const hit = this.firstCharacterCollision(currentOrigin, remaining, height);
      if (!hit) {
        resolved.add(remaining);
        break;
      }
      const horizontalMovement = Math.abs(remaining.clone().normalize().dot(this.camera.up)) < 0.2;
      if (!stepped && horizontalMovement && this.navigationSettings.stepHeight > 0) {
        const raisedOrigin = currentOrigin.clone().addScaledVector(this.camera.up, this.navigationSettings.stepHeight);
        if (!this.firstCharacterCollision(raisedOrigin, remaining, height)) {
          resolved.addScaledVector(this.camera.up, this.navigationSettings.stepHeight);
          currentOrigin.copy(raisedOrigin);
          stepped = true;
          continue;
        }
      }
      const distance = remaining.length();
      const direction = remaining.clone().multiplyScalar(1 / distance);
      const advanceDistance = Math.min(distance, Math.max(0, hit.distance - this.cameraConstraints.collisionRadius));
      const advance = direction.multiplyScalar(advanceDistance);
      resolved.add(advance);
      currentOrigin.add(advance);
      const unconsumed = remaining.clone().sub(advance);
      const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? direction.clone().negate();
      remaining = slideAgainstSurface(unconsumed, normal).multiplyScalar(0.98);
    }
    this.lastNavigationSweepMs = performance.now() - sweepStartedAt;
    const now = performance.now();
    if (now - this.lastNavigationDiagnosticsNotify >= 250) {
      this.lastNavigationDiagnosticsNotify = now;
      this.onNavigationDiagnosticsChange?.(this.getNavigationCollisionDiagnostics());
    }
    return resolved;
  }
  protected recoverCharacterSpawn(start: THREE.Vector3, height: number): THREE.Vector3 {
    if (!this.characterOverlapsScene(start, height)) return start;
    const stride = Math.max(this.cameraConstraints.collisionRadius * 2.5, 0.6);
    for (let ring = 1; ring <= 10; ring += 1) {
      for (let index = 0; index < 12; index += 1) {
        const angle = (index / 12) * Math.PI * 2;
        const candidate = start.clone().add(new THREE.Vector3(Math.cos(angle) * stride * ring, 0, Math.sin(angle) * stride * ring));
        const floor = this.findFloorHeight(candidate.clone().add(new THREE.Vector3(0, 4, 0)));
        if (floor !== undefined) candidate.y = floor + height;
        if (!this.characterOverlapsScene(candidate, height)) return candidate;
      }
    }
    const bounds = this.sceneContentBox();
    return bounds.isEmpty() ? start : new THREE.Vector3(start.x, bounds.max.y + height + this.cameraConstraints.collisionRadius, start.z);
  }
  protected characterOverlapsScene(top: THREE.Vector3, height: number): boolean {
    const samples = [top, top.clone().addScaledVector(this.camera.up, -Math.max(this.cameraConstraints.collisionRadius, height * 0.5))];
    for (const root of this.visibleModelObjects()) {
      let overlaps = false;
      root.traverse((object) => {
        if (overlaps || !object.visible) return;
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
        const box = new THREE.Box3().setFromObject(mesh).expandByScalar(this.cameraConstraints.collisionRadius * 0.7);
        if (samples.some((sample) => box.containsPoint(sample))) overlaps = true;
      });
      if (overlaps) return true;
    }
    return false;
  }
  protected firstCharacterCollision(topOrigin: THREE.Vector3, movement: THREE.Vector3, height: number): THREE.Intersection<THREE.Object3D> | undefined {
    const distance = movement.length();
    if (distance <= 1e-8) return;
    const direction = movement.clone().multiplyScalar(1 / distance);
    const radius = this.cameraConstraints.collisionRadius;
    const side = new THREE.Vector3().crossVectors(direction, this.camera.up);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    else side.normalize();
    const sideOffsets = [0, radius * 0.7, -radius * 0.7];
    const verticalOffsets = [0, -Math.max(radius, height * 0.48), -Math.max(radius, height - radius)];
    let nearest: THREE.Intersection<THREE.Object3D> | undefined;
    const objects = this.visibleModelObjects();
    for (const verticalOffset of verticalOffsets) {
      for (const sideOffset of sideOffsets) {
        const origin = topOrigin.clone().addScaledVector(this.camera.up, verticalOffset).addScaledVector(side, sideOffset);
        this.raycaster.set(origin, direction);
        this.navigationRaySamples += 1;
        this.raycaster.near = 0.01;
        this.raycaster.far = distance + radius;
        const hit = this.raycaster.intersectObjects(objects, true)[0];
        if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
      }
    }
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    return nearest;
  }
  protected updateNavigationCollisionDebug(now: number, force = false): void {
    if (!this.navigationCollisionDebugVisible) return;
    if (force || now - this.lastNavigationDebugRefresh >= 500) {
      this.lastNavigationDebugRefresh = now;
      this.clearNavigationCollisionDebug();
      for (const model of this.models.values()) {
        if (!model.visible || !model.object.visible) continue;
        const box = visibleObjectBox(model.object);
        if (box.isEmpty()) continue;
        const helper = new THREE.Box3Helper(box, 0x49c7ff);
        helper.name = `navigation-collider:${model.id}`;
        helper.renderOrder = 10_000;
        const material = helper.material as THREE.LineBasicMaterial;
        material.transparent = true;
        material.opacity = 0.72;
        material.depthTest = false;
        this.navigationCollisionDebugGroup.add(helper);
      }
      const radius = this.cameraConstraints.collisionRadius;
      const height = this.navigationMode === "thirdPerson" ? 1.75 : this.navigationSettings.eyeHeight;
      const geometry = new THREE.CapsuleGeometry(radius, Math.max(0.01, height - radius * 2), 4, 8);
      const material = new THREE.MeshBasicMaterial({ color: 0xf5c65c, wireframe: true, transparent: true, opacity: 0.88, depthTest: false });
      this.navigationDebugCapsule = new THREE.Mesh(geometry, material);
      this.navigationDebugCapsule.name = "navigation-character-capsule";
      this.navigationDebugCapsule.renderOrder = 10_001;
      this.navigationCollisionDebugGroup.add(this.navigationDebugCapsule);
    }
    if (!this.navigationDebugCapsule) return;
    const height = this.navigationMode === "thirdPerson" ? 1.75 : this.navigationSettings.eyeHeight;
    const top = this.navigationMode === "thirdPerson" && this.avatar ? this.avatar.position.clone().add(new THREE.Vector3(0, height, 0)) : this.camera.position.clone();
    this.navigationDebugCapsule.position.copy(top).addScaledVector(this.camera.up, -height / 2);
    this.navigationDebugCapsule.visible = this.navigationMode !== "orbit";
  }
  protected clearNavigationCollisionDebug(): void {
    for (const child of [...this.navigationCollisionDebugGroup.children]) this.disposeObject(child);
    this.navigationDebugCapsule = undefined;
  }
}
