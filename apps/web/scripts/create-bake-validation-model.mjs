import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

class NodeFileReader {
  result = null;
  error = null;
  onloadend = null;

  readAsArrayBuffer(blob) {
    blob.arrayBuffer()
      .then((buffer) => {
        this.result = buffer;
        this.onloadend?.({ target: this });
      })
      .catch((error) => {
        this.error = error;
        this.onloadend?.({ target: this });
      });
  }

  readAsDataURL(blob) {
    blob.arrayBuffer()
      .then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onloadend?.({ target: this });
      })
      .catch((error) => {
        this.error = error;
        this.onloadend?.({ target: this });
      });
  }
}

globalThis.FileReader = NodeFileReader;

const scene = new THREE.Scene();
scene.name = "BIM Studio Lightmap Validation";

const materials = {
  floor: new THREE.MeshStandardMaterial({ name: "Warm concrete", color: 0xb7a996, roughness: 0.92 }),
  wall: new THREE.MeshStandardMaterial({ name: "Neutral wall", color: 0xd8d7d0, roughness: 0.86 }),
  red: new THREE.MeshStandardMaterial({ name: "Red object", color: 0x9f332f, roughness: 0.62 }),
  blue: new THREE.MeshStandardMaterial({ name: "Blue object", color: 0x315b8d, roughness: 0.55 }),
  metal: new THREE.MeshStandardMaterial({ name: "Metal object", color: 0xa7adb3, roughness: 0.28, metalness: 0.72 }),
};

function box(name, size, position, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.fromArray(position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

box("Floor", [10, 0.25, 8], [0, -0.125, 0], materials.floor);
box("Back wall", [10, 5, 0.25], [0, 2.5, -3.875], materials.wall);
box("Left wall", [0.25, 5, 8], [-4.875, 2.5, 0], materials.wall);
box("Canopy", [4.2, 0.24, 2.8], [0.7, 3.15, -0.6], materials.wall);
box("Canopy column A", [0.34, 3.15, 0.34], [-1.15, 1.575, -1.65], materials.wall);
box("Canopy column B", [0.34, 3.15, 0.34], [2.55, 1.575, -1.65], materials.wall);
box("Red block", [1.6, 1.7, 1.6], [-2.8, 0.85, 0.9], materials.red).rotation.y = 0.22;
box("Blue block", [1.25, 2.5, 1.25], [1.2, 1.25, 1.15], materials.blue).rotation.y = -0.32;

const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.78, 32, 20), materials.metal);
sphere.name = "Metal sphere";
sphere.position.set(3.25, 0.78, 1.35);
sphere.castShadow = true;
sphere.receiveShadow = true;
scene.add(sphere);

const exporter = new GLTFExporter();
const binary = await new Promise((resolve, reject) => {
  exporter.parse(scene, resolve, reject, { binary: true, onlyVisible: true });
});
if (!(binary instanceof ArrayBuffer)) throw new Error("GLTFExporter did not return a binary GLB");

const outputDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "test-output");
const outputPath = join(outputDirectory, "bake-validation.glb");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputPath, Buffer.from(binary));
console.log(`[bake-fixture] ${outputPath} (${binary.byteLength} bytes)`);
