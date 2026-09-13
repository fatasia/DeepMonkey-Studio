import { Document, WebIO } from "@gltf-transform/core";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { editOptimizerDocument, type OptimizerLayerEdit } from "./optimizerLayers";
import { OptimizerLayerSession } from "./optimizerLayerSession";

it.skipIf(!process.env.OPTIMIZER_LAYER_BENCH)("measures repeated layer edits against read/edit/write without browser claims", async () => {
  const io = new WebIO(), doc = new Document(), buffer = doc.createBuffer();
  const positions = new Float32Array(1_500_000 * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = Math.sin(i * .01);
  const accessor = doc.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer);
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", accessor));
  const scene = doc.createScene();
  for (let i = 0; i < 1500; i++) {
    const node = doc.createNode(`设备 ${i}`);
    if (i === 1499) node.setMesh(mesh);
    scene.addChild(node);
  }
  const binary = await io.writeBinary(doc) as Uint8Array<ArrayBuffer>;
  const file = new File([binary], "QA-continuous-layers.glb");
  const legacy: number[] = [], cached: number[] = [];
  const session = new OptimizerLayerSession(io);
  const setupStart = performance.now();
  await session.open("bench", file); await session.draft([], true);
  const setupMs = performance.now() - setupStart;
  const edits: OptimizerLayerEdit[] = [];
  for (let i = 0; i < 10; i++) {
    edits.push(i % 3 === 0 ? { id: i, action: "rename", name: `新设备 ${i}` } : i % 3 === 1 ? { id: i, action: "hidden", hidden: true } : { id: i, action: "delete" });
    let start = performance.now();
    const baseline = await io.readBinary(new Uint8Array(await file.arrayBuffer()));
    editOptimizerDocument(baseline, edits); await io.writeBinary(baseline);
    legacy.push(performance.now() - start);
    start = performance.now();
    const result = await session.draft(edits, false);
    cached.push(performance.now() - start);
    expect(result.previewBinary).toBeUndefined();
  }
  const start = performance.now();
  const saved = await session.materialize(edits);
  const serializeMs = performance.now() - start;
  expect((await io.readBinary(saved.binary)).getRoot().listNodes()).toHaveLength(1497);
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const report = { runtime: "Node glTF-Transform; excludes browser rendering and transfer", bytes: binary.byteLength, nodes: 1500, vertices: 1_500_000, edits: 10, setupMs, serializeMs, legacy, cached, legacyMedianMs: median(legacy), cachedMedianMs: median(cached), speedup: median(legacy) / median(cached) };
  await writeFile("../../test-output/resources-final-0909/optimizer-layer-benchmark.json", JSON.stringify(report, null, 2));
  await writeFile("../../test-output/resources-final-0909/QA-continuous-layers.glb", binary);
  console.info(JSON.stringify(report));
}, 60_000);
