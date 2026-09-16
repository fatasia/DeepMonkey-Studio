import type { DeformationSnapshot } from "../deformation/types.js";
import { array, fields, record, requireValue } from "./primitives.js";

type Numbers = (input: unknown, path: string, maxInteger?: number) => number[];

/** Browser JSON decoder; data types are restored before the shared deformation validator runs. */
export function materializePacketDeformation(input: unknown, path: string, numbers: Numbers): DeformationSnapshot {
  const value = record(input, path); fields(value, ["sources", "poses"], [], path);
  const floats = (value: unknown, path: string) => new Float32Array(numbers(value, path));
  const sources = array(value.sources, `${path}.sources`, 4096).map((input, index) => {
    const p = `${path}.sources[${index}]`, source = record(input, p);
    let morph: Record<string, unknown> | undefined, skinning: Record<string, unknown> | undefined;
    if (Object.hasOwn(source, "morph")) {
      const raw = record(source.morph, `${p}.morph`), primitive = record(raw.primitive, `${p}.morph.primitive`);
      const targets = array(primitive.targets, `${p}.morph.primitive.targets`, 256).map((input, index) => {
        const target = record(input, `${p}.morph.primitive.targets[${index}]`), restored = { ...target };
        for (const key of ["positionDeltas", "normalDeltas", "tangentDeltas"]) if (Object.hasOwn(target, key)) restored[key] = floats(target[key], `${p}.target.${key}`);
        return restored;
      });
      morph = { ...raw, positions: floats(raw.positions, `${p}.morph.positions`), primitive: { ...primitive, targets } };
      for (const key of ["normals", "tangents"]) if (Object.hasOwn(raw, key)) morph[key] = floats(raw[key], `${p}.morph.${key}`);
    }
    if (Object.hasOwn(source, "skinning")) {
      const raw = record(source.skinning, `${p}.skinning`), joints = raw.joints;
      let indices: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
      if (joints && typeof joints === "object" && Object.hasOwn(joints, "componentType")) {
        const encoded = record(joints, `${p}.skinning.joints`); fields(encoded, ["componentType", "values"], [], `${p}.skinning.joints`);
        requireValue(encoded.componentType === "uint16" || encoded.componentType === "uint32", p, "Invalid joint component type.");
        indices = encoded.componentType === "uint16" ? new Uint16Array(numbers(encoded.values, p, 65535)) : new Uint32Array(numbers(encoded.values, p, 0xffff_ffff));
      } else indices = new Uint32Array(numbers(joints, `${p}.skinning.joints`, 0xffff_ffff));
      skinning = { ...raw, positions: floats(raw.positions, `${p}.skinning.positions`), normals: floats(raw.normals, `${p}.skinning.normals`),
        weights: floats(raw.weights, `${p}.skinning.weights`), joints: indices };
      if (Object.hasOwn(raw, "tangents")) skinning.tangents = floats(raw.tangents, `${p}.skinning.tangents`);
    }
    return { ...source, ...(morph ? { morph } : {}), ...(skinning ? { skinning } : {}) };
  });
  const poses = array(value.poses, `${path}.poses`, 16_384).map((input, index) => {
    const p = `${path}.poses[${index}]`, pose = record(input, p), result = { ...pose };
    if (Object.hasOwn(pose, "morphWeights")) {
      const weights = record(pose.morphWeights, `${p}.morphWeights`);
      result.morphWeights = { ...weights, values: floats(weights.values, `${p}.morphWeights.values`) };
    }
    if (Object.hasOwn(pose, "palette")) {
      const palette = record(pose.palette, `${p}.palette`);
      result.palette = { ...palette, matrices: floats(palette.matrices, `${p}.palette.matrices`),
        ...(Object.hasOwn(palette, "normalMatrices") ? { normalMatrices: floats(palette.normalMatrices, `${p}.palette.normalMatrices`) } : {}) };
    }
    return result;
  });
  return { sources, poses } as unknown as DeformationSnapshot;
}

export function deformationForBrowserJson(snapshot: DeformationSnapshot): unknown {
  return { ...snapshot, sources: snapshot.sources.map(source => ({ ...source,
    ...(source.skinning ? { skinning: { ...source.skinning, joints: {
      componentType: source.skinning.joints instanceof Uint16Array ? "uint16" : "uint32", values: Array.from(source.skinning.joints),
    } } } : {}),
  })) };
}

/** Runtime package v1 targets Native too; its current reader cannot execute Browser deformation. */
export function assertNativePacketDeformationSupported(value: { readonly deformation?: unknown; readonly instances?: readonly { readonly pose?: unknown }[] }): void {
  if (value.deformation !== undefined || value.instances?.some(instance => instance.pose !== undefined)) {
    throw new Error("Native runtime package does not support deformation; use Browser RenderPacket serialization.");
  }
}
