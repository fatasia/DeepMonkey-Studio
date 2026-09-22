import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "test-output", "scene-publish-offline-20260919-os-preflight");
await mkdir(output, { recursive: true });

function run(args) {
  const result = spawnSync("netsh", args, { windowsHide: true, encoding: "buffer" });
  return {
    command: ["netsh", ...args].join(" "),
    exit: result.status ?? -1,
    stdoutHex: Buffer.from(result.stdout ?? []).toString("hex"),
    stderrHex: Buffer.from(result.stderr ?? []).toString("hex"),
  };
}

const state = run(["advfirewall", "show", "allprofiles", "state"]);
const policy = run(["advfirewall", "show", "allprofiles", "firewallpolicy"]);
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  readOnly: true,
  mutatingFirewallHelper: { priorExit: 1, priorEvidence: "test-output/scene-publish-offline-20260918-main/evidence.json" },
  state,
  policy,
  interpretation: state.exit === 0 && policy.exit === 0
    ? "host firewall is enabled with a recorded inbound/outbound policy; this is a read-only host preflight, not proof of clean-machine offline startup"
    : "host firewall preflight failed; OS-level evidence remains boundary-only",
};
await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ output: path.join(output, "evidence.json"), stateExit: state.exit, policyExit: policy.exit }));
