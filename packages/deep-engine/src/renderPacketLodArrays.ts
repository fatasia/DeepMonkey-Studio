/** Public packets may be direct JavaScript objects, not only JSON arrays. */
export function assertDenseLodArray(value: readonly unknown[]): void {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error("LOD arrays require own, dense elements.");
  }
}
