import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ViewerMaterialActivity } from "./viewerMaterialActivity";

describe("ViewerMaterialActivity", () => {
  it("leaves ordinary static materials asleep and treats unknown shaders/hooks conservatively", () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); scene.add(mesh);
    const activity = new ViewerMaterialActivity(vi.fn());
    activity.refresh(scene); expect(activity.active()).toBe(false);
    mesh.onBeforeRender = () => undefined;
    activity.refresh(scene); expect(activity.active()).toBe(true);
    mesh.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
    mesh.material = new THREE.ShaderMaterial() as unknown as THREE.MeshStandardMaterial;
    activity.refresh(scene); expect(activity.active()).toBe(true);
    activity.dispose(); expect(activity.active()).toBe(false);
  });

  it("tracks video play/pause/seek and removes every listener on refresh or dispose", () => {
    const invalidate = vi.fn();
    const video = Object.assign(new EventTarget(), { paused: true, ended: false, readyState: 4 });
    const texture = new THREE.VideoTexture(video as unknown as HTMLVideoElement);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const activity = new ViewerMaterialActivity(invalidate); activity.refresh(scene);
    expect(activity.active()).toBe(false);
    video.paused = false; video.dispatchEvent(new Event("playing"));
    expect(activity.active()).toBe(true); expect(invalidate).toHaveBeenCalledTimes(1);
    video.paused = true; video.dispatchEvent(new Event("pause")); video.dispatchEvent(new Event("seeked"));
    expect(activity.active()).toBe(false); expect(invalidate).toHaveBeenCalledTimes(3);
    activity.refresh(scene); video.dispatchEvent(new Event("loadeddata")); expect(invalidate).toHaveBeenCalledTimes(4);
    video.paused = false; video.ended = true; expect(activity.active()).toBe(false);
    material.map = null; activity.refresh(scene); video.dispatchEvent(new Event("playing"));
    expect(invalidate).toHaveBeenCalledTimes(4);
    activity.dispose(); texture.dispose(); material.dispose();
  });

  it("keeps UV loops live and stops a one-shot only after its final frame", () => {
    const material = new THREE.MeshStandardMaterial();
    material.userData.studioUvAnimation = { enabled: true, loopMode: "once", durationSeconds: 2 };
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const activity = new ViewerMaterialActivity(vi.fn()); activity.refresh(scene);
    expect(activity.active()).toBe(true);
    material.userData.studioUvAnimationElapsed = 2; expect(activity.active()).toBe(false);
    material.userData.studioUvAnimation.loopMode = "loop"; expect(activity.active()).toBe(true);
    material.userData.studioUvAnimation.enabled = false; expect(activity.active()).toBe(false);
    activity.dispose();
  });
});
