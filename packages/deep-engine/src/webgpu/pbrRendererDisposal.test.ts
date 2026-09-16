import { describe, expect, it, vi } from "vitest";
import { PbrRenderer } from "./pbrRenderer.js";

describe("PBR renderer teardown", () => {
  it("releases every owner and device even when multiple early owners throw", () => {
    const calls: string[] = [], owner = (name: string) => ({ dispose: vi.fn(() => { calls.push(name); }) });
    const renderer = { ground: { author: owner("author") }, outputs: owner("outputs"), environment: owner("environment"),
      lighting: owner("lighting"), localShadows: owner("localShadows"), shadowState: owner("shadowState"),
      previousHiZ: owner("previousHiZ"), transparency: owner("transparency"), postProcess: owner("postProcess"),
      packets: owner("packets"), targets: owner("targets"), cameraHistory: { reset: vi.fn(() => { calls.push("cameraHistory"); }) },
      session: owner("session") };
    const first = Error("overlay teardown"), second = Error("environment teardown");
    renderer.ground.author.dispose.mockImplementationOnce(() => { calls.push("author"); throw first; });
    renderer.environment.dispose.mockImplementationOnce(() => { calls.push("environment"); throw second; });
    let failure: unknown;
    try { PbrRenderer.prototype.dispose.call(renderer as never); } catch (error) { failure = error; }
    expect(calls).toEqual(["author", "outputs", "environment", "lighting", "localShadows", "shadowState", "previousHiZ",
      "transparency", "postProcess", "packets", "targets", "cameraHistory", "session"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([first, second]);
  });
});
