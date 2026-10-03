import RAPIER from "@dimforge/rapier3d-compat";
import type { WorldVec3 } from "@bim-studio/contracts";

export type Rapier = typeof RAPIER;
export type World = InstanceType<Rapier["World"]>;
export type RigidBody = InstanceType<Rapier["RigidBody"]>;
export type ColliderDesc = InstanceType<Rapier["ColliderDesc"]>;

/** 与 Viewer 一致的静态地面：顶面 y=0、摩擦 0.9。 */
export const GROUND_HALF_EXTENTS: WorldVec3 = [5_000, 0.05, 5_000];
export const GROUND_FRICTION = 0.9;

let rapierReady: Promise<Rapier> | undefined;

/** Rapier compat 内嵌 wasm，Node 无头可用；只屏蔽其已知的上游弃用提示，其它告警原样透传。 */
export function loadRapier(): Promise<Rapier> {
  rapierReady ??= (async () => {
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (args[0] !== "using deprecated parameters for the initialization function; pass a single object instead") warn(...args);
    };
    try {
      await RAPIER.init();
    } finally {
      console.warn = warn;
    }
    return RAPIER;
  })();
  return rapierReady;
}

let reference: World | undefined;

/** 默认积分参数的只读参照世界（进程内一份，永不释放）；restore 用它覆盖快照里可被伪造的求解旋钮。 */
export function referenceWorld(rapier: Rapier): World {
  reference ??= new rapier.World({ x: 0, y: -9.81, z: 0 });
  return reference;
}

