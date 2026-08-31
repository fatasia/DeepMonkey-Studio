import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import type { SceneLightState, SkyboxPreset, WeatherMode } from "@bim-studio/contracts";
import { shouldRenderSceneLightProxy } from "./viewerTypes";
import { createSceneGrid } from "./sceneGrid";
import { configureDirectionalShadow } from "./sceneShadowQuality";
import { DEFAULT_SCENE_LIGHTS } from "./viewerEngineTypes";
import { ViewerEngineRendering } from "./viewerEngineRendering";

/** Environment 职责层。 */
export abstract class ViewerEngineEnvironment extends ViewerEngineRendering {
  protected setupEnvironment(): void {
      this.syncSceneLights();
      this.globalIlluminationLight.name = "scene-light:global-illumination";
      this.scene.add(this.globalIlluminationLight);
      this.gridHelper = createSceneGrid();
      this.scene.add(this.gridHelper);
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.ShadowMaterial({ opacity: 0.12 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      ground.name = "helper:ground";
      this.groundHelper = ground;
      this.scene.add(ground);
      this.setSceneEnvironment(this.environmentState);
      this.setWeather("sunny");
    }
  protected async applyEnvironment(): Promise<void> {
      const preset = this.environmentState.skybox;
      let environment: THREE.Texture | undefined;
      if (this.environmentState.environmentMapUrl) {
        try {
          environment = await this.loadEnvironmentTexture(this.environmentState.environmentMapUrl);
          if (this.externalEnvironmentTexture && this.externalEnvironmentTexture !== environment) this.externalEnvironmentTexture.dispose();
          this.externalEnvironmentTexture = environment;
        } catch {
          environment = undefined;
        }
      }
      const sky = preset === "none" ? undefined : this.getSkyboxTexture(preset);
      this.scene.environment = this.lightingState.reflectionsEnabled === false ? null : environment ?? sky ?? null;
      this.scene.environmentIntensity = this.environmentState.environmentIntensity ?? 1;
      this.scene.background = this.environmentState.environmentAsBackground && environment
        ? environment
        : sky ?? new THREE.Color(this.environmentState.backgroundColor);
      this.scheduleRendererPipelineWarmup();
    }
  protected async loadEnvironmentTexture(url: string): Promise<THREE.Texture> {
      const path = url.split(/[?#]/)[0]?.toLowerCase() ?? "";
      const texture = path.endsWith(".hdr")
        ? await new RGBELoader().loadAsync(url)
        : path.endsWith(".exr")
          ? await new EXRLoader().loadAsync(url)
          : await new THREE.TextureLoader().loadAsync(url);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      if (!path.endsWith(".hdr") && !path.endsWith(".exr")) texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      return texture;
    }
  protected getSkyboxTexture(preset: Exclude<SkyboxPreset, "none">): THREE.CanvasTexture {
      const cached = this.skyboxTextures.get(preset);
      if (cached) return cached;
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 512;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建天空盒画布");
  
      const palettes = {
        studio: ["#172126", "#75828a", "#d8d4ca"],
        "bright-studio": ["#d9e1e3", "#eef2f1", "#cbd2d0"],
        clear: ["#4e88b5", "#a6d2e8", "#e7eef0"],
        overcast: ["#5d6970", "#a5adb0", "#d8d8d2"],
        dawn: ["#263655", "#cf8d78", "#f1d5aa"],
        sunset: ["#342b55", "#d27b72", "#f3c78f"],
        night: ["#050a18", "#101d3b", "#26385b"],
        "industrial-night": ["#050b10", "#122b36", "#234955"]
      } as const;
      const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, palettes[preset][0]);
      gradient.addColorStop(0.52, palettes[preset][1]);
      gradient.addColorStop(1, palettes[preset][2]);
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
  
      if (preset === "studio" || preset === "bright-studio") {
        // 中性顶部柔光仅用于环境反射与背景，不改变模型材质或贴图。
        const softbox = context.createRadialGradient(500, 120, 15, 500, 120, 310);
        softbox.addColorStop(0, "rgba(255,255,255,.58)");
        softbox.addColorStop(0.45, "rgba(230,238,240,.18)");
        softbox.addColorStop(1, "rgba(210,220,224,0)");
        context.fillStyle = softbox;
        context.fillRect(160, 0, 680, 410);
      } else if (preset === "clear" || preset === "overcast") {
        context.fillStyle = "rgba(255,255,255,.17)";
        const cloudAlpha = preset === "overcast" ? 0.34 : 0.17;
        context.fillStyle = `rgba(255,255,255,${cloudAlpha})`;
        for (const [x, y, width] of [[120, 270, 240], [520, 235, 310], [830, 290, 180]] as const) {
          context.beginPath();
          context.ellipse(x, y, width, 18, 0, 0, Math.PI * 2);
          context.fill();
        }
      } else if (preset === "sunset" || preset === "dawn") {
        const sun = context.createRadialGradient(730, 285, 5, 730, 285, 95);
        sun.addColorStop(0, "rgba(255,244,190,.96)");
        sun.addColorStop(0.2, "rgba(255,205,126,.72)");
        sun.addColorStop(1, "rgba(255,150,90,0)");
        context.fillStyle = sun;
        context.fillRect(620, 175, 220, 220);
      } else if (preset === "night") {
        let seed = 2463534242;
        for (let index = 0; index < 180; index += 1) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const x = seed % canvas.width;
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const y = seed % 340;
          const radius = index % 17 === 0 ? 1.4 : 0.7;
          context.fillStyle = index % 11 === 0 ? "rgba(190,215,255,.95)" : "rgba(255,255,255,.72)";
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fill();
        }
      } else {
        context.strokeStyle = "rgba(79,205,222,.1)";
        context.lineWidth = 1;
        for (let x = 0; x <= canvas.width; x += 64) {
          context.beginPath();
          context.moveTo(x, 310);
          context.lineTo(x, canvas.height);
          context.stroke();
        }
        const horizon = context.createLinearGradient(0, 250, 0, 420);
        horizon.addColorStop(0, "rgba(67,208,224,0)");
        horizon.addColorStop(0.55, "rgba(67,208,224,.19)");
        horizon.addColorStop(1, "rgba(67,208,224,0)");
        context.fillStyle = horizon;
        context.fillRect(0, 250, canvas.width, 170);
      }
  
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.needsUpdate = true;
      this.skyboxTextures.set(preset, texture);
      return texture;
    }
  protected applyLighting(): void {
      const weatherFactor: Record<WeatherMode, number> = {
        sunny: 1,
        cloudy: 0.78,
        rain: 0.58,
        snow: 0.78,
        fog: 0.66,
        storm: 0.42
      };
      const intensity = this.lightingState.enabled ? this.lightingState.intensity : 0;
      for (const state of this.lightingState.lights ?? DEFAULT_SCENE_LIGHTS) {
        const light = this.sceneLights.get(state.id);
        if (!light) continue;
        light.visible = this.lightingState.enabled && state.enabled;
        light.intensity = state.intensity * weatherFactor[this.weatherMode] * intensity;
        if ("castShadow" in light) light.castShadow = Boolean(this.lightingState.shadowsEnabled && state.castShadow);
      }
      this.globalIlluminationLight.visible = Boolean(this.lightingState.enabled && this.lightingState.globalIlluminationEnabled);
      this.globalIlluminationLight.intensity = this.globalIlluminationLight.visible
        ? (this.lightingState.globalIlluminationIntensity ?? 0.45) * weatherFactor[this.weatherMode] * intensity
        : 0;
      if ("shadowMap" in this.renderer) this.renderer.shadowMap.enabled = Boolean(this.lightingState.shadowsEnabled);
      this.renderer.toneMappingExposure = this.lightingState.enabled
        ? THREE.MathUtils.clamp(0.72 + intensity * weatherFactor[this.weatherMode] * 0.33, 0.55, 1.55)
        : 0.55;
      this.markShadowMapDirty();
      this.scheduleRendererPipelineWarmup();
    }
  protected syncSceneLights(): void {
      this.disposeSceneLightProxies();
      for (const light of this.sceneLights.values()) {
        if (light.parent) light.parent.remove(light);
      }
      for (const target of this.sceneLightTargets.values()) if (target.parent) target.parent.remove(target);
      this.sceneLights.clear();
      this.sceneLightTargets.clear();
      for (const state of this.lightingState.lights ?? DEFAULT_SCENE_LIGHTS) {
        const color = new THREE.Color(state.color);
        let light: THREE.Light;
        if (state.type === "ambient") light = new THREE.AmbientLight(color, state.intensity);
        else if (state.type === "hemisphere") light = new THREE.HemisphereLight(color, new THREE.Color(state.groundColor ?? "#3b4249"), state.intensity);
        else if (state.type === "point") light = new THREE.PointLight(color, state.intensity, state.distance ?? 0, state.decay ?? 2);
        else if (state.type === "spot") {
          const spot = new THREE.SpotLight(color, state.intensity, state.distance ?? 0, state.angle ?? Math.PI / 6, state.penumbra ?? 0.25, state.decay ?? 2);
          spot.target.name = `scene-light-target:${state.id}`;
          spot.target.position.set(state.target?.x ?? 0, state.target?.y ?? 0, state.target?.z ?? 0);
          this.scene.add(spot.target);
          this.sceneLightTargets.set(state.id, spot.target);
          light = spot;
        } else if (state.type === "rectArea") {
          const area = new THREE.RectAreaLight(color, state.intensity, state.width ?? 6, state.height ?? 4);
          const target = new THREE.Object3D();
          target.name = `scene-light-target:${state.id}`;
          target.position.set(state.target?.x ?? 0, state.target?.y ?? 0, state.target?.z ?? 0);
          this.scene.add(target);
          this.sceneLightTargets.set(state.id, target);
          light = area;
        } else {
          const directional = new THREE.DirectionalLight(color, state.intensity);
          directional.target.name = `scene-light-target:${state.id}`;
          directional.target.position.set(state.target?.x ?? 0, state.target?.y ?? 0, state.target?.z ?? 0);
          configureDirectionalShadow(directional);
          this.scene.add(directional.target);
          this.sceneLightTargets.set(state.id, directional.target);
          light = directional;
        }
        light.name = `scene-light:${state.id}`;
        light.position.set(state.position?.x ?? 0, state.position?.y ?? 6, state.position?.z ?? 0);
        if (state.type === "rectArea") light.lookAt(state.target?.x ?? 0, state.target?.y ?? 0, state.target?.z ?? 0);
        light.visible = state.enabled;
        if ("castShadow" in light) light.castShadow = Boolean(state.castShadow);
        this.sceneLights.set(state.id, light);
        this.scene.add(light);
        if (shouldRenderSceneLightProxy(this.readOnlyMode, state.type)) this.createSceneLightProxy(state);
      }
      if (this.selectedSceneLight) {
        const selection = this.selectedSceneLight;
        const object = selection.handle === "position" ? this.sceneLights.get(selection.id) : this.sceneLightTargets.get(selection.id);
        if (object) this.transform.attach(object);
        else this.clearSceneLightSelection();
      }
    }
  protected createSceneLightProxy(state: SceneLightState): void {
      const position = new THREE.Group();
      position.name = `helper:scene-light-proxy:${state.id}:position`;
      const color = new THREE.Color(state.color);
      const bodyMaterial = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: state.enabled ? 0.95 : 0.42 });
      const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xffcf66, wireframe: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.78 });
      const body = state.type === "rectArea"
        ? new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.72, 0.08), bodyMaterial)
        : state.type === "spot"
          ? new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.72, 16, 1, true), bodyMaterial)
          : new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), bodyMaterial);
      body.renderOrder = 1001;
      position.add(body);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.035, 6, 28), ringMaterial);
      ring.renderOrder = 1001;
      position.add(ring);
      position.traverse((object) => {
        object.userData.sceneLightId = state.id;
        object.userData.sceneLightHandle = "position";
      });
      this.scene.add(position);
  
      let target: THREE.Group | undefined;
      let line: THREE.Line | undefined;
      if (["directional", "spot", "rectArea"].includes(state.type)) {
        target = new THREE.Group();
        target.name = `helper:scene-light-proxy:${state.id}:target`;
        const targetMaterial = new THREE.MeshBasicMaterial({ color: 0x4d9fff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 });
        const targetRing = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.035, 6, 24), targetMaterial);
        targetRing.renderOrder = 1001;
        target.add(targetRing);
        const cross = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 0, 0),
            new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 0.5, 0),
            new THREE.Vector3(0, 0, -0.5), new THREE.Vector3(0, 0, 0.5)
          ]),
          new THREE.LineBasicMaterial({ color: 0x4d9fff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 })
        );
        cross.renderOrder = 1001;
        target.add(cross);
        target.traverse((object) => {
          object.userData.sceneLightId = state.id;
          object.userData.sceneLightHandle = "target";
        });
        this.scene.add(target);
        line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
          new THREE.LineDashedMaterial({ color: 0x76afff, dashSize: 0.35, gapSize: 0.22, depthTest: false, depthWrite: false, transparent: true, opacity: 0.55 })
        );
        line.name = `helper:scene-light-direction:${state.id}`;
        line.renderOrder = 1000;
        this.scene.add(line);
      }
      this.sceneLightProxies.set(state.id, { position, ...(target ? { target } : {}), ...(line ? { line } : {}) });
      this.updateSceneLightProxies();
    }
  protected disposeSceneLightProxies(): void {
      for (const proxy of this.sceneLightProxies.values()) {
        this.disposeObject(proxy.position);
        if (proxy.target) this.disposeObject(proxy.target);
        if (proxy.line) this.disposeObject(proxy.line);
      }
      this.sceneLightProxies.clear();
    }
  protected updateSceneLightProxies(): void {
      for (const [id, proxy] of this.sceneLightProxies) {
        const light = this.sceneLights.get(id);
        if (!light) continue;
        proxy.position.position.copy(light.position);
        const positionScale = THREE.MathUtils.clamp(this.camera.position.distanceTo(light.position) * 0.035, 0.45, 3.5);
        proxy.position.scale.setScalar(positionScale);
        proxy.position.quaternion.copy(this.camera.quaternion);
        const targetObject = this.sceneLightTargets.get(id);
        if (proxy.target && targetObject) {
          proxy.target.position.copy(targetObject.position);
          const targetScale = THREE.MathUtils.clamp(this.camera.position.distanceTo(targetObject.position) * 0.03, 0.4, 3);
          proxy.target.scale.setScalar(targetScale);
          proxy.target.quaternion.copy(this.camera.quaternion);
        }
        if (proxy.line && targetObject) {
          const position = proxy.line.geometry.getAttribute("position") as THREE.BufferAttribute;
          position.setXYZ(0, light.position.x, light.position.y, light.position.z);
          position.setXYZ(1, targetObject.position.x, targetObject.position.y, targetObject.position.z);
          position.needsUpdate = true;
          proxy.line.computeLineDistances();
        }
      }
    }
  protected lightProxyPointerHit(event: PointerEvent): { id: string; handle: "position" | "target" } | undefined {
      if (this.readOnlyMode) return undefined;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointerPosition.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      this.raycaster.setFromCamera(this.pointerPosition, this.camera);
      const roots = [...this.sceneLightProxies.values()].flatMap((proxy) => proxy.target ? [proxy.position, proxy.target] : [proxy.position]);
      const hit = this.raycaster.intersectObjects(roots, true)[0]?.object;
      let current: THREE.Object3D | null | undefined = hit;
      while (current) {
        const id = current.userData.sceneLightId as string | undefined;
        const handle = current.userData.sceneLightHandle as "position" | "target" | undefined;
        if (id && handle) return { id, handle };
        current = current.parent;
      }
      return undefined;
    }
  protected floorStateKey(modelId: string, level: string): string {
      return `${modelId}\u0000${level}`;
    }
  protected createRainEffect(): THREE.LineSegments {
      const count = 750;
      const positions = new Float32Array(count * 6);
      const speeds = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        const offset = index * 6;
        const x = THREE.MathUtils.randFloatSpread(42);
        const y = THREE.MathUtils.randFloat(-14, 22);
        const z = THREE.MathUtils.randFloatSpread(42);
        positions.set([x, y, z, x - 0.06, y - THREE.MathUtils.randFloat(0.7, 1.5), z + 0.04], offset);
        speeds[index] = THREE.MathUtils.randFloat(18, 30);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const effect = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xa8d8f2, transparent: true, opacity: 0.55, depthWrite: false })
      );
      effect.name = "helper:weather-rain";
      effect.frustumCulled = false;
      effect.userData.speeds = speeds;
      return effect;
    }
  protected createSnowEffect(): THREE.Points {
      const count = 950;
      const positions = new Float32Array(count * 3);
      const speeds = new Float32Array(count);
      const drift = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        positions.set([THREE.MathUtils.randFloatSpread(44), THREE.MathUtils.randFloat(-14, 22), THREE.MathUtils.randFloatSpread(44)], index * 3);
        speeds[index] = THREE.MathUtils.randFloat(1.2, 3.2);
        drift[index] = THREE.MathUtils.randFloat(0.2, 0.8);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const effect = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ color: 0xffffff, size: 0.075, transparent: true, opacity: 0.82, depthWrite: false })
      );
      effect.name = "helper:weather-snow";
      effect.frustumCulled = false;
      effect.userData.speeds = speeds;
      effect.userData.drift = drift;
      return effect;
    }
  protected updateWeather(delta: number): void {
      const effect = this.weatherEffect;
      if (!effect) return;
      effect.position.copy(this.camera.position);
      const attribute = effect.geometry.getAttribute("position") as THREE.BufferAttribute;
      const positions = attribute.array as Float32Array;
      const speeds = effect.userData.speeds as Float32Array;
      if (effect instanceof THREE.LineSegments) {
        for (let index = 0; index < speeds.length; index += 1) {
          const offset = index * 6;
          const fall = speeds[index]! * delta;
          positions[offset + 1]! -= fall;
          positions[offset + 4]! -= fall;
          if (positions[offset + 4]! < -16) {
            const height = THREE.MathUtils.randFloat(32, 40);
            positions[offset + 1]! += height;
            positions[offset + 4]! += height;
          }
        }
      } else {
        const drift = effect.userData.drift as Float32Array;
        const time = performance.now() * 0.001;
        for (let index = 0; index < speeds.length; index += 1) {
          const offset = index * 3;
          positions[offset]! += Math.sin(time + index) * drift[index]! * delta;
          positions[offset + 1]! -= speeds[index]! * delta;
          if (positions[offset + 1]! < -16) positions[offset + 1]! += THREE.MathUtils.randFloat(32, 40);
        }
      }
      attribute.needsUpdate = true;
    }
  protected disposeWeatherEffect(): void {
      if (!this.weatherEffect) return;
      this.scene.remove(this.weatherEffect);
      this.weatherEffect.geometry.dispose();
      const material = this.weatherEffect.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
      this.weatherEffect = undefined;
    }
}
