const CODEC_VERSION = "0.8.3";
const threePath = /(^|\/)node_modules\/(?:\.pnpm\/three@[^/]+\/node_modules\/)?three\//;
const codecPath = /^(?:\.\.\/)*node_modules\/(?:\.pnpm\/fflate@0\.8\.3\/node_modules\/)?fflate\//;

export function assertRuntimeDependencies(dependencies = {}) {
  for (const [name, version] of Object.entries(dependencies)) {
    if (name !== "fflate" || version !== CODEC_VERSION) {
      throw new Error(`Unexpected runtime dependency: ${name}@${version}`);
    }
  }
}

export function bundledInputBytes(metafile) {
  return Object.fromEntries(Object.keys(metafile.inputs).map(input => [input,
    Object.values(metafile.outputs).reduce((sum, output) => sum + (output.inputs[input]?.bytesInOutput ?? 0), 0)]));
}

export function assertLabInputs(inputs, allowedDependencies, outputInputBytes) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new Error("Every Lab entry must publish its complete build input manifest.");
  }
  if (!Array.isArray(allowedDependencies) || allowedDependencies.some(name => name !== "three")) {
    throw new Error("Lab dependency allowlists may contain only the explicit Three comparison boundary.");
  }
  for (const input of Object.keys(inputs)) {
    const normalized = input.replaceAll("\\", "/");
    const local = /^(src|lab|fixtures)\//.test(normalized);
    // esbuild records barrel imports even when they contribute no emitted code.
    // Keep their provenance, while rejecting any Three code in the independent entry.
    const allowedThree = threePath.test(normalized)
      && (allowedDependencies.includes("three") || outputInputBytes?.[input] === 0);
    if (!local && !codecPath.test(normalized) && !allowedThree) {
      throw new Error(`Runtime build escaped the independent package: ${input}`);
    }
  }
}
