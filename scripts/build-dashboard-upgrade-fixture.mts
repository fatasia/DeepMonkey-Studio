import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseDeepRuntimePackage, runtimeContentSha256, runtimePackageSha256,
  serializeDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";

const [source, output, ...extra] = process.argv.slice(2);
if (!source || !output || extra.length) throw new Error("Usage: tsx scripts/build-dashboard-upgrade-fixture.mts <standalone.exe> <new-fixture.exe>");
const bytes = await readFile(source);
assert.equal(bytes.subarray(-48, -40).toString("ascii"), "DMDASH01");
const size = Number(bytes.readBigUInt64LE(bytes.length - 40));
assert(Number.isSafeInteger(size) && size > 0 && size <= bytes.length - 48);
const start = bytes.length - 48 - size;
const original = bytes.subarray(start, -48);
assert.equal(createHash("sha256").update(original).digest("hex"), bytes.subarray(-32).toString("hex"));
assert(parseDeepRuntimePackage(original).valid);
const pkg = JSON.parse(original.toString("utf8"));
const resource = pkg.resources.find((entry: { kind: string }) => entry.kind === "chart-runtime");
assert(resource, "Upgrade fixture requires a real chart payload");
const chart = pkg.payloads[resource.id];
assert.deepEqual(chart.chart.datasets[0].rows, [["A", 37], ["B", 91]]);
chart.chart.datasets[0].rows = [["A", 91], ["B", 37]];
chart.revision++; resource.revision = chart.revision;
resource.contentHash.value = runtimeContentSha256(chart);
pkg.packageVersion = "1.0.1";
pkg.packageHash.value = runtimePackageSha256(pkg);
const payload = Buffer.from(serializeDeepRuntimePackage(pkg));
assert(parseDeepRuntimePackage(payload).valid);
const footer = Buffer.alloc(48); footer.write("DMDASH01", "ascii");
footer.writeBigUInt64LE(BigInt(payload.length), 8);
createHash("sha256").update(payload).digest().copy(footer, 16);
await writeFile(output, Buffer.concat([bytes.subarray(0, start), payload, footer]), { flag: "wx" });
console.log(JSON.stringify({ scope: "synthetic-upgrade-from-published-chart", packageHash: pkg.packageHash.value,
  packageVersion: pkg.packageVersion, rows: chart.chart.datasets[0].rows }));
