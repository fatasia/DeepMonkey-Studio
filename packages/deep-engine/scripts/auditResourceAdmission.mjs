import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/** Static call-site inventory, not an ownership proof: aliases and runtime device wrappers require review. */
export function scanResourceAllocations(file, code) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true), calls = [];
  const memberCall = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);
  const gateway = file.replaceAll("\\", "/") === "webgpu/resourceAdmission.ts";
  const visit = node => {
    if (memberCall(node) && ["createBuffer", "createTexture", "createQuerySet"].includes(node.expression.name.text)) {
      const parent = node.parent;
      const owned = memberCall(parent) && parent.expression.name.text === "own";
      calls.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        operation: node.expression.name.text, receiver: node.expression.expression.getText(source),
        boundary: gateway ? "admitted-gateway" : owned ? "ownership-after-allocation" : "separate-owner-review" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return calls;
}

export async function auditResourceAdmission(root) {
  const calls = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|testUtils)\.tsx?$/.test(entry.name)) {
        calls.push(...scanResourceAllocations(path.relative(root, absolute).replaceAll("\\", "/"), await readFile(absolute, "utf8")));
      }
    }
  }
  await visit(root);
  return { schema: 1, scope: "src/**/*.ts(x), excluding test/testUtils files; direct member calls only",
    summary: Object.fromEntries(["admitted-gateway", "ownership-after-allocation", "separate-owner-review"]
      .map(boundary => [boundary, calls.filter(call => call.boundary === boundary).length])), calls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await auditResourceAdmission(fileURLToPath(new URL("../src/", import.meta.url))), null, 2));
}
