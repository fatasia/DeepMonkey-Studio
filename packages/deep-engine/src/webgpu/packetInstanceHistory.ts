import type { PreparedBatch } from "../renderPacket.js";
import type { CachedPacketBatch } from "./packetBufferTypes.js";

const INSTANCE_FLOATS = 36;
export const PREVIOUS_TRANSFORM_FLOATS = 12;

interface TransformHistory {
  readonly geometry: string;
  readonly data: Float32Array<ArrayBuffer>;
  readonly offset: number;
}

export function collectTransformHistory(
  batches: ReadonlyMap<string, CachedPacketBatch>,
): ReadonlyMap<string, TransformHistory> {
  const history = new Map<string, TransformHistory>();
  for (const { source, previousTransforms } of batches.values()) {
    source.instanceIds.forEach((id, index) => history.set(id, {
      geometry: source.geometry,
      data: previousTransforms,
      offset: index * PREVIOUS_TRANSFORM_FLOATS,
    }));
  }
  return history;
}

/** Packs only model rows. New objects and geometry replacements start with zero motion. */
export function packPreviousTransforms(
  source: PreparedBatch,
  history?: ReadonlyMap<string, TransformHistory>,
): Float32Array<ArrayBuffer> {
  const packed = new Float32Array(source.count * PREVIOUS_TRANSFORM_FLOATS);
  source.instanceIds.forEach((id, index) => {
    const target = index * PREVIOUS_TRANSFORM_FLOATS;
    const previous = history?.get(id);
    const data = previous?.geometry === source.geometry ? previous.data : source.data;
    const offset = previous?.geometry === source.geometry ? previous.offset : index * INSTANCE_FLOATS;
    packed.set(data.subarray(offset, offset + PREVIOUS_TRANSFORM_FLOATS), target);
  });
  return packed;
}

/** Captures the current model rows only after the frame using them was submitted successfully. */
export function packCurrentTransforms(source: PreparedBatch): Float32Array<ArrayBuffer> {
  const packed = new Float32Array(source.count * PREVIOUS_TRANSFORM_FLOATS);
  for (let index = 0; index < source.count; index++) {
    const sourceOffset = index * INSTANCE_FLOATS;
    packed.set(
      source.data.subarray(sourceOffset, sourceOffset + PREVIOUS_TRANSFORM_FLOATS),
      index * PREVIOUS_TRANSFORM_FLOATS,
    );
  }
  return packed;
}
