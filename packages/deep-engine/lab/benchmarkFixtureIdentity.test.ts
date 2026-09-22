import { describe, expect, it } from "vitest";
import { createBenchmarkScene } from "./benchmarkScene.js";
import { benchmarkFixtureIdentity } from "./benchmarkFixtureIdentity.js";

describe("binary fixture identity", () => {
  it("hashes binary texture content without expanding every byte into JSON properties", async () => {
    const fixture = createBenchmarkScene(1024), data = new Uint8Array(1024 * 1024 * 4);
    const source = { ...fixture, packet: { ...fixture.packet, textures: [{ id: "large", revision: 1,
      width: 1024, height: 1024, semantic: "baseColor" as const, data }] } };
    const first = JSON.stringify(await benchmarkFixtureIdentity(source));
    data[data.length - 1] = 1;
    const second = JSON.stringify(await benchmarkFixtureIdentity(source));
    expect(first.length).toBeLessThan(500_000);
    expect(second).not.toEqual(first);
    expect(second).not.toContain('"4194303":');
  });
});
