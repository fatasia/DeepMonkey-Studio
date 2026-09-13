import { SceneAnimationMixer } from "@bim-studio/deep-engine";
import { decodeAnimatedGlb } from "@bim-studio/deep-engine/gltf";
import { SceneTransformGraph } from "@bim-studio/deep-engine";

export interface AnimationRuntimeProbeResult {
  readonly action: "gltf-animation-runtime";
  readonly success: boolean;
  readonly nodes: number;
  readonly clips: number;
  readonly sampledTracks: number;
  readonly childWorldTranslation: readonly [number, number, number];
  readonly ownedSamples: boolean;
}

/** Parses an embedded GLB clip and applies it through the real mixer and transform graph. */
export function verifyAnimationRuntime(): AnimationRuntimeProbeResult {
  const glb = animationGlb();
  const decoded = decodeAnimatedGlb(glb, { clipPrefix: "lab" });
  const graph = new SceneTransformGraph<number>();
  graph.transaction((draft) => {
    for (const node of decoded.nodes) draft.create({ id: node.id, parent: node.parent, localTransform: node.localTransform });
  });
  const mixer = new SceneAnimationMixer<number>();
  for (const clip of decoded.clips) mixer.registerClip(clip);
  mixer.play({ id: "base", clipId: decoded.clips[0]!.id, wrapMode: "clamp" });
  const frame = mixer.sampleAndApply(graph, 0.5);
  const world = graph.getNode(1)!.worldMatrix;
  const childWorldTranslation = [world[12], world[13], world[14]] as const;
  const samples = decoded.clips[0]!.tracks[0]!.times;
  const ownedSamples = samples instanceof Float32Array && samples.buffer !== glb.buffer;
  const success = decoded.nodes.length === 2 && decoded.clips.length === 1 && frame.sampledTracks === 1
    && Math.abs(childWorldTranslation[0] - 1) < 1e-6 && Math.abs(childWorldTranslation[1] - 1) < 1e-6
    && Math.abs(childWorldTranslation[2]) < 1e-6 && ownedSamples;
  return Object.freeze({ action: "gltf-animation-runtime", success, nodes: decoded.nodes.length, clips: decoded.clips.length,
    sampledTracks: frame.sampledTracks, childWorldTranslation, ownedSamples });
}

function animationGlb(): Uint8Array<ArrayBuffer> {
  const binary = new Float32Array([0, 1, 0, 1, 0, 2, 1, 0]);
  const document = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: "root", children: [1] }, { name: "animated", translation: [0, 1, 0] }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }, { buffer: 0, byteOffset: 8, byteLength: 24 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: "VEC3" },
    ],
    animations: [{ name: "move", samplers: [{ input: 0, output: 1, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] }],
  };
  return encodeGlb(document, new Uint8Array(binary.buffer));
}

function encodeGlb(document: object, binary: Uint8Array): Uint8Array<ArrayBuffer> {
  const source = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = (source.byteLength + 3) & ~3, binLength = (binary.byteLength + 3) & ~3;
  const result = new Uint8Array(12 + 8 + jsonLength + 8 + binLength), view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  result.fill(0x20, 20, 20 + jsonLength); result.set(source, 20);
  const binHeader = 20 + jsonLength;
  view.setUint32(binHeader, binLength, true); view.setUint32(binHeader + 4, 0x004e4942, true);
  result.set(binary, binHeader + 8);
  return result;
}
