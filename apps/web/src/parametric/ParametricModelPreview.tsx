import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Box, RotateCcw } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ParametricCadBuildResult } from "./parametricCadTypes";

export function ParametricModelPreview({ result, locale = "zh-CN" }: { result: ParametricCadBuildResult | undefined; locale?: AppLocale }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<(() => void) | undefined>(undefined);
  const [error, setError] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !result) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" }); }
    catch { setError(true); return; }
    setError(false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100_000);
    camera.up.set(0, 0, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.prepend(renderer.domElement);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.triangles, 1));
    if (result.normals.length === result.vertices.length) geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    else geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const material = new THREE.MeshStandardMaterial({ metalness: 0.65, roughness: 0.3 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const environment = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environmentMap = pmrem.fromScene(environment);
    scene.environment = environmentMap.texture;
    scene.environmentIntensity = 0.8;
    const box = geometry.boundingBox!;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
    const key = new THREE.DirectionalLight();
    key.intensity = 2;
    key.position.copy(center).add(new THREE.Vector3(size, -size, size * 2));
    key.target.position.copy(center);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -size, right: size, top: size, bottom: -size, near: 0.1, far: size * 6 });
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = size * 0.0002;
    const rim = new THREE.DirectionalLight();
    rim.intensity = 1;
    rim.position.copy(center).add(new THREE.Vector3(-size, size, size));
    scene.add(key, key.target, rim);
    const floorGeometry = new THREE.PlaneGeometry(size * 6, size * 6);
    const floorMaterial = new THREE.ShadowMaterial({ opacity: 0.2 });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.position.set(center.x, center.y, box.min.z - size * 0.015);
    floor.receiveShadow = true;
    scene.add(floor);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.maxDistance = size * 8;
    controls.minDistance = size * 0.15;
    camera.near = Math.max(size / 10_000, 0.01);
    camera.far = size * 100;
    const render = () => renderer.render(scene, camera);
    const reset = () => {
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(1.2, -1.2, 0.95).normalize().multiplyScalar(size * Math.max(1.6, 1.4 / camera.aspect)));
      camera.updateProjectionMatrix();
      controls.update();
      render();
    };
    resetRef.current = reset;
    const updateTheme = () => {
      const style = getComputedStyle(host);
      const color = (token: string) => new THREE.Color(style.getPropertyValue(token).trim());
      scene.background = color("--surface-2");
      scene.fog = new THREE.Fog(scene.background, size * 3, size * 8);
      material.color.copy(color("--text-muted"));
      floorMaterial.color.copy(color("--on-accent-dark"));
      key.color.copy(color("--on-accent-light"));
      rim.color.copy(color("--accent"));
      render();
    };
    const theme = new MutationObserver(updateTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    updateTheme();
    controls.addEventListener("change", render);
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      renderer.setSize(Math.max(1, entry.contentRect.width), Math.max(1, entry.contentRect.height), false);
      camera.aspect = Math.max(1, entry.contentRect.width) / Math.max(1, entry.contentRect.height);
      reset();
    });
    resize.observe(host);
    reset();
    return () => {
      resetRef.current = undefined;
      resize.disconnect(); theme.disconnect(); controls.dispose();
      geometry.dispose(); material.dispose(); floorGeometry.dispose(); floorMaterial.dispose();
      environmentMap.dispose(); environment.dispose(); pmrem.dispose();
      key.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [result]);

  return <div className="parametric-preview" ref={hostRef}>
    {(!result || error) && <div className="parametric-preview-empty"><Box size={44} strokeWidth={1} /><strong>{error ? tr(locale, "三维预览暂不可用", "3D preview unavailable") : tr(locale, "让描述变成可编辑的部件", "Turn an idea into an editable part")}</strong><small>{error ? tr(locale, "可保存资源或导出 STEP 后继续", "Save the asset or export STEP to continue") : tr(locale, "描述需求或点击样例，生成后调整尺寸", "Describe a part or choose an example, then refine its dimensions")}</small></div>}
    {result && !error && <><button type="button" className="parametric-reset-view" aria-label={tr(locale, "重置模型视角", "Reset model view")} title={tr(locale, "重置视角", "Reset view")} onClick={() => resetRef.current?.()}><RotateCcw size={16} /></button><small className="parametric-orbit-hint">{tr(locale, "拖动旋转 · 滚轮缩放", "Drag to orbit · Scroll to zoom")}</small></>}
  </div>;
}
