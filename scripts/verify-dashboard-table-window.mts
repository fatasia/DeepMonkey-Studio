import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";
const directory = path.resolve(process.argv[2]!);
const output = path.join(directory, "table-interaction"); await mkdir(output, { recursive: true });
const packagePath = path.join(directory, "runtime-package.json");
const envelope = JSON.parse(await readFile(packagePath, "utf8"));
const dashboard = envelope.payloads[envelope.entrypoints.dashboard];
const table = dashboard.tables[0], page = dashboard.pages.find((page: any) => page.id === table.pageId);
const frame = page.nodes.find((node: any) => node.id === table.nodeIds[0]).frame;
const size = [960, 540], scale = Math.min(size[0]! / page.width, size[1]! / page.height);
const point = (control: any) => [Math.round((frame[0] + control.rect[0] + control.rect[2] / 2) * scale),
  Math.round((frame[1] + control.rect[1] + control.rect[3] / 2) * scale)];
const authored = table.families[0].orders[0];
const controls = authored.pages[0].controls;
const sort = controls.find((control: any) => control.action === "sort");
const sorted = table.families[0].orders.find((order: any) => order.column === sort.column && order.direction === "asc");
const evidence = [];
for (const round of [1, 2]) for (const format of ["csv", "xlsx"]) {
  const filename = path.join(output, `round-${round}.${format}`);
  const control = sorted.pages[0].controls.find((control: any) => control.action === format);
  const capture = await captureNativePlayerWindow({ label: `round-${round}-${format}`, executable: path.join(directory, "deep-engine-native.exe"),
    args: ["--package", packagePath], outputDirectory: output, clientSize: size, preClicks: [point(sort)], clientClick: point(control), reportPath: filename,
    env: { ...process.env, LOCALAPPDATA: path.join(output, "local"), DEEP_DASHBOARD_FILTER_EVIDENCE: "1" }, presentedMarker: "native Deep2d", timeoutMs: 60_000 });
  assert.deepEqual(await readFile(filename), Buffer.from(sorted.exports[format], "base64"));
  assert.match(capture.playerLogTail, /dashboard table exported/); evidence.push(capture);
}
const csv = controls.find((control: any) => control.action === "csv");
evidence.push(await captureNativePlayerWindow({ label: "cancel", executable: path.join(directory, "deep-engine-native.exe"), args: ["--package", packagePath],
  outputDirectory: output, clientSize: size, clientClick: point(csv), cancelReport: true, env: { ...process.env, LOCALAPPDATA: path.join(output, "local") }, presentedMarker: "native Deep2d", timeoutMs: 60_000 }));
await writeFile(path.join(output, "evidence.json"), JSON.stringify({ table: table.id, sort: sort.column, captures: evidence }, null, 2));
console.log("Native table export exact-byte and cancellation windows passed");
