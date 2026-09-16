import type { DashboardCandidateHost, DashboardPageCandidate, DashboardResourceLoader } from "./dashboardCandidateTypes.js";
import { DashboardCandidateController } from "./dashboardCandidateController.js";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export function fixture() {
  const loaded: object[] = [], released: object[] = [], prepared: string[] = [];
  const frames: DashboardPageCandidate[] = [], releasedFrames: DashboardPageCandidate[] = [];
  let epoch = 1, visible: DashboardPageCandidate | undefined;
  const loader: DashboardResourceLoader<object, object> = {
    async load() { const value = {}; loaded.push(value); return value; },
    async prepare(item, value) { prepared.push(item.resourceId); return value; },
    release(_item, value) { released.push(value); },
  };
  const host: DashboardCandidateHost<object, object, DashboardPageCandidate> = {
    currentDeviceEpoch: () => epoch,
    async prepare(page, resources) {
      if (resources.length !== 9) throw new Error("Incomplete resource barrier.");
      frames.push(page); return page;
    },
    commitVisible(page) { visible = page; },
    release(page) { releasedFrames.push(page); },
  };
  return { loader, host, loaded, released, prepared, frames, releasedFrames,
    controller: new DashboardCandidateController(loader, host),
    visible: () => visible, setEpoch(value: number) { epoch = value; } };
}
export function update(page: DashboardPageCandidate, index: number, value: string) {
  const node = page.nodes.filter(node => node.chart)[index]!, chart = node.chart!;
  const dataset = chart.ir.datasets[0]!;
  return { nodeId: node.node.id, message: { schema: "deep-engine.chart-data-update", schemaVersion: 1,
    chartId: chart.ir.id, expectedDataRevision: chart.dataRevision, dataRevision: chart.dataRevision + 1,
    datasets: [{ kind: "replace", datasetId: dataset.id, rows: [[value, 12, 0.5, "updated"]] }] } };
}
