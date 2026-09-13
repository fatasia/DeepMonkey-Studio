import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

if (!process.argv[2]) throw new Error("Pass the production-built ordinaryPicking.worker JavaScript file");
const source = pathToFileURL(resolve(process.argv[2])).href;
const worker = new Worker(`const { parentPort } = require("node:worker_threads");
globalThis.self = globalThis;
globalThis.postMessage = (data, options) => parentPort.postMessage(data, options?.transfer);
import(${JSON.stringify(source)}).then(() => parentPort.on("message", data => globalThis.onmessage({data})));`, { eval: true });
const geometry = new THREE.PlaneGeometry(100, 100, 100, 100);
const position = geometry.getAttribute("position").array;
const index = geometry.index.array;
const snapshot = { position: position.slice(), index: index.slice(), start: 0, count: Infinity };
try {
  const serialized = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker did not respond")), 10000);
    worker.once("error", error => { clearTimeout(timeout); reject(error); });
    worker.once("message", data => { clearTimeout(timeout); data.serialized ? resolve(data.serialized) : reject(new Error(data.error)); });
    worker.postMessage(snapshot, [snapshot.position.buffer, snapshot.index.buffer]);
  });
  const bvh = MeshBVH.deserialize(serialized, geometry, { setIndex: false });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const raycaster = new THREE.Raycaster(new THREE.Vector3(1.234, 2.345, 10), new THREE.Vector3(0, 0, -1));
  const expected = raycaster.intersectObject(mesh)[0]; const actual = []; bvh.raycastObject3D(mesh, raycaster, actual);
  if (actual[0]?.faceIndex !== expected.faceIndex || actual[0]?.distance !== expected.distance || position.byteLength === 0 || index.byteLength === 0) throw new Error("Worker result changed picking or detached live geometry");
  console.log(JSON.stringify({ workerBundle: process.argv[2], triangles: index.length / 3, sourceBuffersIntact: true, snapshotTransferred: snapshot.position.byteLength === 0,
    faceIndex: actual[0].faceIndex, distance: actual[0].distance, indexBytes: serialized.roots.reduce((sum, root) => sum + root.byteLength, 0) + serialized.indirectBuffer.byteLength }));
  geometry.dispose(); mesh.material.dispose();
} finally { await worker.terminate(); }
