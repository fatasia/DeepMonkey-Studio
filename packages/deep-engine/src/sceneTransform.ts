export type Vector3State = readonly [number, number, number];

export interface TransformPatch {
  readonly position?: Vector3State;
  readonly rotation?: Vector3State;
  readonly scale?: Vector3State;
}

export interface TransformState {
  readonly position: Vector3State;
  readonly rotation: Vector3State;
  readonly scale: Vector3State;
}

export const defaultTransform: TransformState = Object.freeze({
  position: Object.freeze([0, 0, 0]) as Vector3State,
  rotation: Object.freeze([0, 0, 0]) as Vector3State,
  scale: Object.freeze([1, 1, 1]) as Vector3State,
});

export function freezeTransform(transform: TransformState): TransformState {
  for (const [key, value] of Object.entries(transform)) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
      throw new Error(`Transform ${key} must contain three finite numbers.`);
    }
  }
  return Object.freeze({
    position: Object.freeze([...transform.position]) as Vector3State,
    rotation: Object.freeze([...transform.rotation]) as Vector3State,
    scale: Object.freeze([...transform.scale]) as Vector3State,
  });
}
