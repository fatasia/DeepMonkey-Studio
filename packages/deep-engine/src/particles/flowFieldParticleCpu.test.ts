import { expect, it } from "vitest";
import { advanceFlowParticleCpu } from "./flowFieldParticleCpu.js";
it("retains lifetime policy, zero-flow baseline, bounded speed and deterministic drift", () => {
  const seed = { id: 17, position: [.31, -.27, .41], velocity: [2, 1, 0], lifetime: .2, age: .1, flags: 1 } as const;
  const input = { deltaTime: .2, acceleration: [0, -.5, 0], drag: .1 } as const;
  expect(advanceFlowParticleCpu(seed, input)).toEqual(advanceFlowParticleCpu(seed, { ...input, flow: { phase: .2, flowStrength: 0 } }));
  const flow = { ...input, flow: { phase: .2, flowStrength: 4, maxSpeed: .5, seed: 41 } };
  const actual = advanceFlowParticleCpu(seed, flow)!;
  expect(actual).toEqual(advanceFlowParticleCpu(seed, flow)); expect(actual).not.toEqual(advanceFlowParticleCpu(seed, input));
  expect(Math.hypot(...actual.velocity)).toBeLessThan(.500001); expect(actual.age).toBeLessThan(seed.lifetime);
  expect(advanceFlowParticleCpu({ ...seed, flags: 0 }, flow)).toBeUndefined();
});
