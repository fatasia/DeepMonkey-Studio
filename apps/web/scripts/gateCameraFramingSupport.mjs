import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";
import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three";
import sharp from "sharp";

export const gripperUid = "71df42c5d5964d2ea149c5513bbc061b";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Only previously reviewed local assets enter this isolated fixture; no downloads or real data writes. */
export async function prepareReviewedGripper(gate) {
  const cache = resolve(import.meta.dirname, "../../../data/external-assets/source-b");
  const target = resolve(gate.output, "data/external-assets/source-b");
  const audit = JSON.parse(await readFile(resolve(cache, "audit.json"), "utf8"));
  await Promise.all(["models", "reviewed-thumbnails"].map(path => mkdir(resolve(target, path), { recursive: true })));
  for (const name of ["catalog.json", "audit.json"]) await copyFile(resolve(cache, name), resolve(target, name));
  for (const item of audit.items) {
    assert.match(item.uid, /^[a-f0-9]{32}$/);
    await copyFile(resolve(cache, "models", `${item.uid}.glb`), resolve(target, "models", `${item.uid}.glb`));
    await copyFile(resolve(cache, "reviewed-thumbnails", `${item.uid}.png`), resolve(target, "reviewed-thumbnails", `${item.uid}.png`));
  }
  const bytes = await readFile(resolve(cache, "models", `${gripperUid}.glb`));
  const reviewed = audit.items.find(item => item.uid === gripperUid);
  assert.equal(reviewed?.status, "approved");
  assert.equal(sha256(bytes), reviewed.contentHash);
  const document = await new NodeIO().readBinary(bytes);
  const bounds = getBounds(document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]);
  const dimensions = bounds.max.map((max, axis) => max - bounds.min[axis]);
  assert.ok(Math.max(...dimensions) < 0.5 && Math.min(...dimensions) > 0, "Use the real sub-meter gripper, not an upscaled replacement");
  return { hash: sha256(bytes), bounds, dimensions, byteLength: bytes.length };
}

export async function importGripper(gate, projectId, page) {
  const imported = await gate.json("POST", `/api/projects/${projectId}/asset-library/community-${gripperUid}/import`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const project = await gate.json("GET", `/api/projects/${projectId}`);
    const model = project.models.find(item => item.id === imported.model.id);
    if (model?.status === "ready") return model;
    assert.notEqual(model?.status, "failed", model?.message);
    await page.waitForTimeout(150);
  }
  throw new Error("Reviewed gripper conversion did not finish");
}

/** Independently project the original GLB world bounds using the camera returned by a real UI save. */
export function projectionOccupancy(bounds, scene, modelId, viewport, view = "focus") {
  const state = scene.models.find(model => model.modelId === modelId);
  assert.ok(state?.visible);
  assert.deepEqual(state.transform.scale, { x: 1, y: 1, z: 1 }, "Framing may not enlarge the model");
  const { position, rotation, scale } = state.transform;
  const modelMatrix = new Matrix4().compose(new Vector3(position.x, position.y, position.z),
    new Quaternion().setFromEuler(new Euler(rotation.x, rotation.y, rotation.z)), new Vector3(scale.x, scale.y, scale.z));
  const camera = new PerspectiveCamera(50, viewport.width / viewport.height, 0.000001, 1e7);
  camera.position.copy(scene.camera.position);
  if (view === "top") camera.up.set(0, 0, -1);
  if (view === "bottom") camera.up.set(0, 0, 1);
  camera.lookAt(new Vector3().copy(scene.camera.target)); camera.updateMatrixWorld(true);
  const points = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    points.push(new Vector3(x, y, z).applyMatrix4(modelMatrix).project(camera));
  }
  const min = { x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)) };
  const max = { x: Math.max(...points.map(p => p.x)), y: Math.max(...points.map(p => p.y)) };
  const width = (max.x - min.x) / 2; const height = (max.y - min.y) / 2;
  return { width, height, area: width * height, longestSide: Math.max(width, height),
    contained: min.x >= -1.05 && min.y >= -1.05 && max.x <= 1.05 && max.y <= 1.05,
    distance: camera.position.distanceTo(new Vector3().copy(scene.camera.target)), camera: scene.camera, viewport, min, max };
}

export function assertUsefulFraming(metrics, step) {
  assert.ok(metrics.contained, `${step}: original model bounds clipped: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.longestSide >= 0.25 && metrics.longestSide <= 0.95,
    `${step}: real model should occupy 25–95% of one viewport dimension, got ${metrics.longestSide}`);
}

export async function changedModelPixels(visible, hidden) {
  const a = await sharp(visible).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(hidden).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(a.info, b.info);
  let changed = 0;
  let minX = a.info.width, minY = a.info.height, maxX = -1, maxY = -1;
  for (let offset = 0; offset < a.data.length; offset += 3) {
    if (Math.max(...[0, 1, 2].map(channel => Math.abs(a.data[offset + channel] - b.data[offset + channel]))) <= 28) continue;
    changed++;
    const pixel = offset / 3, x = pixel % a.info.width, y = Math.floor(pixel / a.info.width);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const width = changed ? (maxX - minX + 1) / a.info.width : 0;
  const height = changed ? (maxY - minY + 1) / a.info.height : 0;
  return { changed, total: a.info.width * a.info.height, ratio: changed / (a.info.width * a.info.height),
    width, height, longestSide: Math.max(width, height), minX, minY, maxX, maxY,
    contained: changed > 0 && minX >= 2 && minY >= 2 && maxX < a.info.width - 2 && maxY < a.info.height - 2 };
}

/** This reviewed fixture has red, green and blue mechanical parts, unlike the neutral scene background. */
export async function visibleGripperPalette(screenshot) {
  const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = { red: 0, green: 0, blue: 0, total: info.width * info.height };
  for (let offset = 0; offset < data.length; offset += 3) {
    const [red, green, blue] = [data[offset], data[offset + 1], data[offset + 2]];
    if (red > 30 && red > green * 1.6 && red > blue * 1.6) pixels.red++;
    if (green > 30 && green > red * 1.6 && green > blue * 1.6) pixels.green++;
    if (blue > 30 && blue > red * 1.6 && blue > green * 1.6) pixels.blue++;
  }
  return pixels;
}
