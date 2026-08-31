import type { Distribution } from "./model.js";

export class Random {
  #state: number;

  public constructor(seed: number) {
    this.#state = seed || 0x6d2b79f5;
  }

  public next(): number {
    let value = this.#state += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  }
}

export function sample(distribution: Distribution, random: Random): number {
  if (distribution.kind === "deterministic") return distribution.value;
  if (distribution.kind === "uniform") return distribution.minimum + (distribution.maximum - distribution.minimum) * random.next();
  if (distribution.kind === "exponential") return -Math.log(1 - random.next()) * distribution.mean;
  const z = Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, random.next()))) * Math.cos(2 * Math.PI * random.next());
  return Math.max(distribution.minimum ?? Number.EPSILON, distribution.mean + z * distribution.standardDeviation);
}

export function seedNumber(seed: string | number): number {
  if (typeof seed === "number") {
    if (!Number.isSafeInteger(seed)) throw new RangeError("numeric seed must be a safe integer");
    return seed >>> 0;
  }
  let value = 2_166_136_261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

export function mixSeed(seed: number, index: number): number {
  let value = seed + index * 0x9e3779b9;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  return (value ^ value >>> 15) >>> 0;
}
