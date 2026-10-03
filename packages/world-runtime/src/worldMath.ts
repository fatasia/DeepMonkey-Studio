import { createHash } from "node:crypto";
import type { WorldQuat, WorldVec3 } from "@bim-studio/contracts";

export class WorldRuntimeError extends Error {
  readonly name = "WorldRuntimeError";
  constructor(
    readonly code:
      | "invalid-scene"
      | "invalid-action"
      | "object-not-found"
      | "limit-exceeded"
      | "snapshot-corrupt",
    message: string,
  ) {
    super(message);
  }
}

export function sha256Hex(...parts: Array<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/** three.js Euler "XYZ" 顺序（弧度）→ 四元数 [x, y, z, w]；与 SceneSnapshot 的 transform.rotation 语义一致。 */
export function eulerXyzToQuaternion([x, y, z]: WorldVec3): WorldQuat {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** mulberry32：纯 32 位整数运算，跨平台逐位一致；状态即 uint32，可直接入快照。 */
export class WorldRng {
  constructor(private state: number) {
    this.state = state >>> 0;
  }

  get value(): number {
    return this.state;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
