/** 真实 ECharts delta→X 包→LPAC→Native painter；产物只写 test-output。 */
import assert from "node:assert/strict";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZRenderPainterCommandBatchExperiment } from "../apps/web/src/experiments/zrenderPainterCommandBatch.ts";
import { ZRenderXDisplayBridge } from "../apps/web/src/experiments/zrenderXDisplayBridge.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "test-output/zrender-x-native", `${process.pid}-${Date.now()}`);
await mkdir(output, { recursive: true });
await copyFile(path.join(root, "packages/deep-engine-native/target/debug/deep-engine-native.exe"), path.join(output, "player.exe"));
await copyFile(path.join(root, "packages/deep-engine-native/target/debug/examples/x_compat_worker.exe"), path.join(output, "deep2d-x-worker.exe"));
const experiment = new ZRenderPainterCommandBatchExperiment(), bridge = new ZRenderXDisplayBridge();
const reports = [];
try {
  for (const values of [[12, 24, 18], [12, 15, 18], [12, 24]]) {
    const result = experiment.renderFrame({ chartId: "x.native-bar", categories: ["A", "B", "C"].slice(0, values.length),
      values, logicalWidth: 320, logicalHeight: 180, domainMax: 30, color: "#5070dd" });
    assert(result.ok, JSON.stringify(result));
    const frozen = bridge.freeze(result.batch), source = path.join(output, `frame-${result.batch.epoch}.json`);
    await writeFile(source, frozen.packageJson);
    const execute = (mode: string) => {
      const child = spawnSync(path.join(output, "player.exe"), [mode, source], {
        encoding: "utf8", timeout: 20_000, windowsHide: true,
        env: { ...process.env, LOCALAPPDATA: path.join(output, "local") },
      });
      assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
      return child.stdout;
    };
    const headless = execute("--headless-x-package");
    const line = headless.split(/\r?\n/).find(line => line.startsWith("Deep2D X runtime package OK: "));
    assert(line);
    const receipt = JSON.parse(line.slice("Deep2D X runtime package OK: ".length));
    const payload = JSON.parse(frozen.packageJson).payloads["x:zrender"].content.request;
    assert.deepEqual(receipt.messages, [{ type: "display-list", data: payload.calls[0].args }]);
    assert.equal(receipt.deep2d.commands, values.length);
    assert.equal(receipt.deep2d.fillTriangles, values.length * 2);
    const gpu = execute("--smoke-x-package");
    assert(gpu.includes("native smoke GPU submission complete: scopes=clean callbacks=clean"));
    assert.equal(gpu.split(/\r?\n/).filter(line => line.startsWith("native X window tick: ")).length, 3);
    reports.push({ epoch: result.batch.epoch, bars: values.length, commands: result.batch.commands.length,
      batchHash: result.batch.outputHash, packageHash: frozen.runtimePackage.packageHash.value,
      fillTriangles: receipt.deep2d.fillTriangles, gpu: "presented" });
  }
} finally { experiment.dispose(); }
const sameWindow = spawnSync("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml",
  "--offline", "--bin", "deep-engine-native", "app::x_drop_tests",
  "--", "--ignored", "--nocapture"], {
  cwd: root, encoding: "utf8", timeout: 60_000, windowsHide: true,
  env: { ...process.env, DEEP_X_DROP_FIXTURES: output },
});
assert.equal(sameWindow.status, 0, `${sameWindow.error ?? ""}\n${sameWindow.stdout}\n${sameWindow.stderr}`);
assert(sameWindow.stdout.includes("X same-window replacements=2 rejected=2 renderer=unchanged checkpoints=presented"));
assert(sameWindow.stdout.includes("X live file replacements=2 checkpoints=presented invalid/ordinary=rejected"));
assert(sameWindow.stdout.includes("X live faults: bad-json=retained ordinary=retained LKG=unchanged valid=recovered"));
assert(sameWindow.stdout.includes("X live present barrier: skipped=old-content retry=presented checkpoint=committed"));
await writeFile(path.join(output, "report.json"), JSON.stringify(reports, null, 2));
console.log(JSON.stringify({ output, sameWindow: "two updates and two rejections verified", reports }, null, 2));
