/// <reference lib="webworker" />
import type { ParametricCadDefinition, ParametricCadFeature, ParametricCadValue } from "@bim-studio/contracts";
import { assertParametricCadDefinition, evaluateParametricValue } from "@bim-studio/parametric-modeling-plugin";
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as replicad from "replicad";
import type { ParametricCadBuildResult } from "./parametricCadTypes";

type Shape = ReturnType<typeof replicad.makeBox>;
interface BuildRequest { id: string; definition: ParametricCadDefinition; }

let runtimePromise: Promise<void> | undefined;

function ensureRuntime(): Promise<void> {
  runtimePromise ??= initOpenCascade({ locateFile: () => wasmUrl }).then((openCascade) => { replicad.setOC(openCascade); });
  return runtimePromise;
}

function vector(values: ParametricCadValue[] | undefined, parameters: Record<string, number>, fallback: [number, number, number]): [number, number, number] {
  return fallback.map((value, index) => evaluateParametricValue(values?.[index], parameters, value)) as [number, number, number];
}

function createFeatureShape(feature: ParametricCadFeature, parameters: Record<string, number>): Shape {
  const position = vector(feature.position, parameters, [0, 0, 0]);
  let shape: Shape;
  if (feature.primitive === "box") {
    const size = vector(feature.size, parameters, [10, 10, 10]);
    shape = replicad.makeBox(position, [position[0] + size[0], position[1] + size[1], position[2] + size[2]]);
  } else if (feature.primitive === "cylinder") {
    shape = replicad.makeCylinder(evaluateParametricValue(feature.radius, parameters, 5), evaluateParametricValue(feature.height, parameters, 10), position);
  } else if (feature.primitive === "sphere") {
    shape = replicad.makeSphere(evaluateParametricValue(feature.radius, parameters, 5)).translate(position) as Shape;
  } else {
    shape = replicad.makeEllipsoid(...vector(feature.axes, parameters, [10, 10, 10])).translate(position) as Shape;
  }
  const rotation = vector(feature.rotation, parameters, [0, 0, 0]);
  if (rotation[0]) shape = shape.rotate(rotation[0], position, [1, 0, 0]) as Shape;
  if (rotation[1]) shape = shape.rotate(rotation[1], position, [0, 1, 0]) as Shape;
  if (rotation[2]) shape = shape.rotate(rotation[2], position, [0, 0, 1]) as Shape;
  return shape;
}

async function build(input: ParametricCadDefinition): Promise<ParametricCadBuildResult> {
  // 先做纯 TypeScript 校验，非法 AI 草案不会触发昂贵的 WASM 初始化。
  const definition = assertParametricCadDefinition(input);
  await ensureRuntime();
  const startedAt = performance.now();
  const parameters = Object.fromEntries(definition.parameters.map((parameter) => [parameter.id, parameter.value]));
  const warnings: string[] = [];
  let result: Shape | undefined;
  try {
    for (const [index, feature] of definition.features.entries()) {
      const operand = createFeatureShape(feature, parameters);
      if (index === 0) { result = operand; continue; }
      const previous = result!;
      result = feature.operation === "union" ? previous.fuse(operand) as Shape
        : feature.operation === "cut" ? previous.cut(operand) as Shape
        : previous.intersect(operand) as Shape;
    }
    if (!result) throw new Error("模型没有生成实体");
    if (definition.edgeTreatment) {
      const radius = evaluateParametricValue(definition.edgeTreatment.radius, parameters);
      if (radius > 0) {
        try { result = definition.edgeTreatment.kind === "fillet" ? result.fillet(radius) as Shape : result.chamfer(radius) as Shape; }
        catch { warnings.push(`${definition.edgeTreatment.kind === "fillet" ? "圆角" : "倒角"}无法应用到全部边，已保留布尔运算结果`); }
      }
    }
    const mesh = result.mesh({ tolerance: 0.15, angularTolerance: 20 });
    const vertices = new Float32Array(mesh.vertices);
    const triangles = new Uint32Array(mesh.triangles);
    const normals = new Float32Array(mesh.normals);
    const step = await result.blobSTEP().arrayBuffer();
    const bounds = result.boundingBox.bounds as [[number, number, number], [number, number, number]];
    return {
      vertices, triangles, normals, step,
      summary: {
        durationMs: Math.round(performance.now() - startedAt), volumeMm3: Math.round(replicad.measureVolume(result) * 100) / 100,
        faceCount: result.faces.length, edgeCount: result.edges.length, triangleCount: triangles.length / 3,
        bounds: structuredClone(bounds), warnings
      }
    };
  } finally {
    result?.delete();
  }
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<BuildRequest>) => {
  const { id, definition } = event.data;
  try {
    const result = await build(definition);
    scope.postMessage({ id, ok: true, result }, [result.vertices.buffer, result.triangles.buffer, result.normals.buffer, result.step]);
  } catch (error) {
    scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
