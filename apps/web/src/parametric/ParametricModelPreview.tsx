import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ParametricCadBuildResult } from "./parametricCadTypes";

export function ParametricModelPreview({ result }: { result: ParametricCadBuildResult | undefined }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !result) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1116);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100_000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.append(renderer.domElement);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(result.vertices, 3));
    if (result.normals.length === result.vertices.length) geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
    else geometry.computeVertexNormals();
    geometry.setIndex(new THREE.BufferAttribute(result.triangles, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x69a7c7, metalness: 0.42, roughness: 0.3 }));
    scene.add(mesh);
    scene.add(new THREE.HemisphereLight(0xd8efff, 0x17212a, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(3, 4, 5);
    scene.add(key);

    const box = geometry.boundingBox!;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(1.2, 0.9, 1.2).normalize().multiplyScalar(size * 1.8));
    camera.near = Math.max(size / 10_000, 0.01);
    camera.far = Math.max(size * 100, 10_000);
    camera.updateProjectionMatrix();
    controls.update();

    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.max(1, entry.contentRect.width);
      const height = Math.max(1, entry.contentRect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    });
    resize.observe(host);
    render();
    return () => {
      resize.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [result]);

  return <div className="parametric-preview" ref={hostRef}>{!result && <div><span>3D</span><strong>调整参数后生成预览</strong><small>几何计算在隔离 Worker 中运行</small></div>}</div>;
}
