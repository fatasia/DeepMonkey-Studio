import { describe, expect, it } from "vitest";
import { StudioWasmPackageCache } from "./StudioWasmPackageCache";

describe("WASM package rebuild gate", () => {
  it("compares every word and trailing byte, including unaligned views", () => {
    const cache = new StudioWasmPackageCache();
    const original = new Uint8Array([1,2,3,4,5,6,7,8,9]);cache.commit(original);
    expect(cache.matches(original.slice())).toBe(true);
    const unaligned = new Uint8Array(10);unaligned.set(original,1);
    expect(cache.matches(unaligned.subarray(1))).toBe(true);
    for (let index=0;index<original.length;index++) {
      const changed=original.slice();changed[index]=changed[index]!^1;expect(cache.matches(changed)).toBe(false);
    }
  });
  it("uses exact detached bytes and clears on lifecycle retirement", () => {
    const cache = new StudioWasmPackageCache();
    const source = new Uint8Array([1, 2, 3]);
    expect(cache.matches(source)).toBe(false);
    cache.commit(source);
    source[2] = 4;
    expect(cache.matches(source)).toBe(false);
    expect(cache.matches(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(cache.matches(new Uint8Array([1, 2]))).toBe(false);
    cache.clear();
    expect(cache.matches(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("does not retain oversized packages", () => {
    const cache = new StudioWasmPackageCache();
    const large = new Uint8Array(256 * 1024 * 1024 + 1);
    cache.commit(large);
    expect(cache.matches(large)).toBe(false);
  });

  it("retains the real SMT production package size without copying it", () => {
    const cache = new StudioWasmPackageCache();
    const smt = new Uint8Array(159.9 * 1024 * 1024);
    smt[smt.byteLength - 1] = 7;
    cache.commit(smt);
    expect(cache.matches(smt)).toBe(true);
    cache.commit(new Uint8Array(1024));
    expect(cache.matches(smt)).toBe(false);
  });
});
