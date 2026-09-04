import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentInvocation, productionServiceName } from "./studioDeployment.mjs";

test("maps the single Node entry to the verified native deployment adapter", () => {
  const linux = deploymentInvocation("deploy", { deploymentCheck: true, skipBuild: false }, "linux");
  assert.equal(linux.command, "bash");
  assert.deepEqual(linux.args.slice(-1), ["--check"]);

  const windows = deploymentInvocation("deploy", { deploymentCheck: false, skipBuild: true }, "win32");
  assert.equal(windows.command, "powershell.exe");
  assert.deepEqual(windows.args.slice(-1), ["-SkipBuild"]);

  const stop = deploymentInvocation("undeploy", {}, "linux");
  assert.deepEqual(stop.args.slice(-1), ["--stop"]);
});

test("uses the current product identity for native service names", () => {
  assert.match(productionServiceName("win32"), /^DeepMonkeyStudioServer-[0-9a-f]{8}$/);
  assert.match(productionServiceName("linux"), /^deep-monkey-studio-[0-9a-f]{8}$/);
});
