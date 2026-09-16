import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ChartSimulationSource } from "./chartSimulation.js";
import { applyChartDataUpdate } from "./chartDataApply.js";
import type { ChartIR } from "./chartIr.js";
const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

it("forks the cursor without sharing pending tokens, cancellation or future ticks", () => {
  const chart = read("chart-ir-v1.json") as ChartIR, sim = new ChartSimulationSource(read("chart-sim-v1.json"), chart);
  const frame = sim.prepare(0, 0)!, state = applyChartDataUpdate(chart, 0, frame.message);
  sim.commit(frame, state.dataRevision);
  const pending = sim.prepare(100, 1)!, fork = sim.fork(state.ir, 1);
  expect(fork.nextDueMs).toBe(sim.nextDueMs);
  expect(() => fork.commit(pending, 2)).toThrow();
  const own = fork.prepare(100, 1)!;
  expect(own).toEqual(pending); fork.commit(own, 2);
  expect(fork.nextDueMs).toBe(200); expect(sim.nextDueMs).toBe(100);
  fork.cancel(); expect(sim.cancelled).toBe(false);
  sim.cancel(); expect(sim.fork(state.ir, 1).cancelled).toBe(true);
});
