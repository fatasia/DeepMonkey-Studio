import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runJ3LifecycleProbe } from "./j3LifecycleProbe.js";

const manifest = JSON.parse(readFileSync(new URL("../fixtures/j3-lifecycle-v1.json", import.meta.url), "utf8"));

it("records real executor transitions against the shared Gate E contract, with stable repeat runs", async () => {
  const first = await runJ3LifecycleProbe(manifest), second = await runJ3LifecycleProbe(manifest);
  expect(first).toEqual(second);
  expect(first.scenarios).toEqual(manifest.scenarios.map((entry: { id: string; expected: unknown }) => ({
    id: entry.id, samples: entry.expected,
  })));
});
