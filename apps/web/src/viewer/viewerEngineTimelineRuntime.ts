import * as THREE from "three";
import type { SceneIKConstraintState } from "@bim-studio/contracts";
import { solveBoneChainIK } from "./ik";
import { applyTransform } from "./sceneObjectUtils";
import { sampleCameraKeyframes, sampleModelAnimationKeyframes, sampleModelKeyframes, sampleSceneAnimation } from "./timeline";
import { ViewerEngineEnvironment } from "./viewerEngineEnvironment";

/** 时间线、骨骼和相机路径运行时。 */
export abstract class ViewerEngineTimelineRuntime extends ViewerEngineEnvironment {
  protected applySceneAnimationFrame(time: number): void {
    // 采样输入先经播放区间收敛：越界 seek 与吸附溢出都不会让关键帧采样越过入点/出点。
    const sampleTime = sampleSceneAnimation(this.sceneAnimation, time);
    const camera = sampleCameraKeyframes(
      this.sceneAnimation.camera,
      sampleTime,
      this.sceneAnimation.cameraInterpolation ?? "smooth",
    );
    if (camera) {
      this.camera.position.set(camera.position.x, camera.position.y, camera.position.z);
      this.orbit.target.set(camera.target.x, camera.target.y, camera.target.z);
      this.avatarVisible = camera.avatarVisible ?? this.avatarVisible;
      if (this.avatar) this.avatar.visible = this.navigationMode === "thirdPerson" && this.avatarVisible;
      this.orbit.update();
    }
    const byModel = new Map<string, typeof this.sceneAnimation.models>();
    for (const frame of this.sceneAnimation.models) {
      const frames = byModel.get(frame.modelId) ?? [];
      frames.push(frame);
      byModel.set(frame.modelId, frames);
    }
    for (const [modelId, frames] of byModel) {
      const transform = sampleModelKeyframes(frames, sampleTime, this.sceneAnimation.modelInterpolation ?? "smooth");
      const model = this.models.get(modelId);
      if (transform && model) applyTransform(model.object, transform);
      const animation = sampleModelAnimationKeyframes(frames, sampleTime);
      if (animation) this.applyTimelineModelAnimation(modelId, animation.clipId, animation.time);
    }
    this.updateSelectionHelper();
    this.updateCollisions(false);
    void this.fragments?.update();
    this.emitCameraChange();
  }

  protected applyTimelineModelAnimation(modelId: string, clipId: string | undefined, time: number): void {
    const mixer = this.mixers.get(modelId);
    const clips = this.animationClips.get(modelId) ?? [];
    if (!mixer || clips.length === 0) return;
    const selected = clipId ? clips.find((clip) => clip.name === clipId || clip.uuid === clipId) : clips[0];
    if (!selected) return;
    const selectedId = selected.name || selected.uuid;
    if (this.animationClipSelection.get(modelId) !== selectedId) {
      mixer.stopAllAction();
      mixer.clipAction(selected).reset().play();
      this.animationClipSelection.set(modelId, selectedId);
    }
    mixer.timeScale = 0;
    mixer.setTime(THREE.MathUtils.clamp(time, 0, selected.duration));
    this.animationEnabledIds.delete(modelId);
  }

  protected modelBone(modelId: string, bonePath: string): THREE.Bone | undefined {
    const object = this.layerObjects.get(modelId)?.get(bonePath) as THREE.Bone | undefined;
    return object?.isBone ? object : undefined;
  }

  protected captureModelBoneRestPose(modelId: string): void {
    const rest = new Map<string, THREE.Quaternion>();
    for (const [path, object] of this.layerObjects.get(modelId) ?? []) {
      const bone = object as THREE.Bone;
      if (bone.isBone) rest.set(path, bone.quaternion.clone());
    }
    if (rest.size > 0) this.modelBoneRestRotations.set(modelId, rest);
  }

  protected normalizeIKConstraint(constraint: SceneIKConstraintState): SceneIKConstraintState {
    const finite = (value: number) => (Number.isFinite(value) ? value : 0);
    return {
      id: constraint.id,
      effectorBonePath: constraint.effectorBonePath,
      target: { x: finite(constraint.target.x), y: finite(constraint.target.y), z: finite(constraint.target.z) },
      chainLength: THREE.MathUtils.clamp(Math.round(constraint.chainLength), 1, 16),
      iterations: THREE.MathUtils.clamp(Math.round(constraint.iterations), 1, 64),
      enabled: Boolean(constraint.enabled),
    };
  }

  protected updateModelRig(): void {
    for (const [modelId, rig] of this.modelRigStates) {
      const model = this.models.get(modelId);
      if (!model) continue;
      for (const pose of rig.bones) {
        const bone = this.modelBone(modelId, pose.bonePath);
        if (bone) bone.rotation.set(pose.rotation.x, pose.rotation.y, pose.rotation.z);
      }
      model.object.updateWorldMatrix(true, true);
      for (const constraint of rig.ik) {
        if (!constraint.enabled) continue;
        const effector = this.modelBone(modelId, constraint.effectorBonePath);
        if (!effector) continue;
        const target = model.object.localToWorld(
          new THREE.Vector3(constraint.target.x, constraint.target.y, constraint.target.z),
        );
        solveBoneChainIK(effector, target, {
          chainLength: constraint.chainLength,
          iterations: constraint.iterations,
        });
      }
    }
  }

  protected updateCameraPathHelper(): void {
    if (this.cameraPathHelper) {
      this.disposeObject(this.cameraPathHelper);
      this.cameraPathHelper = undefined;
    }
    if (!this.sceneAnimation.showCameraPath || this.sceneAnimation.camera.length < 2) return;
    const group = new THREE.Group();
    group.name = "helper:camera-path";
    const sampleCount = Math.min(Math.max(this.sceneAnimation.camera.length * 24, 48), 240);
    const points: THREE.Vector3[] = [];
    for (let index = 0; index <= sampleCount; index += 1) {
      const time = (this.sceneAnimation.duration * index) / sampleCount;
      const state = sampleCameraKeyframes(
        this.sceneAnimation.camera,
        time,
        this.sceneAnimation.cameraInterpolation ?? "smooth",
      );
      if (state) points.push(new THREE.Vector3(state.position.x, state.position.y, state.position.z));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x66b7ff, transparent: true, opacity: 0.8, depthTest: false }),
    );
    line.renderOrder = 18;
    group.add(line);
    for (const frame of this.sceneAnimation.camera) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xf6c453, depthTest: false }),
      );
      marker.position.set(frame.camera.position.x, frame.camera.position.y, frame.camera.position.z);
      marker.renderOrder = 19;
      group.add(marker);
    }
    this.cameraPathHelper = group;
    this.scene.add(group);
  }
}
