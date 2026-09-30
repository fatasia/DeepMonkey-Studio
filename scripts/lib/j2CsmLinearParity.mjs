const families = ["ts-built-in", "ts-deepsl-package", "native-production-wgsl"];
const key = row => `${row.id}/${row.blendStart}/${row.filter}/${row.pattern}`;
export function compareCsmLinear(fixture, fixtureHash, web, native, oracle) {
  const cases = oracle.csmBoundaryCases(fixture), points = oracle.csmBoundaryPoints(fixture);
  let cpuMaxError = 0, crossHostMaxError = 0, linearNearestDifference = 0;
  for (const [host, leg] of [["web", web], ["native", native]]) {
    const ids = host === "web" ? families : [families[2]];
    if (!leg || leg.passed !== true || leg.fixtureHash !== fixtureHash || leg.runs?.length !== 2) throw Error(`${host}: missing current common fixture evidence`);
    if (JSON.stringify(leg.runs[0]) !== JSON.stringify(leg.runs[1])) throw Error(`${host}: repeated GPU output/source drift`);
    for (const run of leg.runs) {
      if (run.passed !== true || run.errors?.length || run.results?.length !== ids.length * cases.length) throw Error(`${host}: failed/missing GPU rows`);
      const expectedKeys = new Set(ids.flatMap(id => cases.map(row => key({ ...row, id }))));
      for (const row of run.results) {
        if (!expectedKeys.delete(key(row)) || row.passed !== true || row.values.length !== points.length
          || !row.values.every(Number.isFinite) || !/^[a-f0-9]{64}$/.test(row.sourceHash) || !/^[a-f0-9]{64}$/.test(row.libraryHash))
          throw Error(`${host}: invalid production sample/source rows`);
        const expected = points.map(point => oracle.referenceCsmVisibility(fixture, row, point.depth, point.u));
        const error = row.values.reduce((max, value, i) => Math.max(max, Math.abs(value - expected[i])), 0);
        if (error > fixture.maxError) throw Error(`${host}: CPU oracle/filter mismatch`);
        cpuMaxError = Math.max(cpuMaxError, error);
      }
      if (expectedKeys.size) throw Error(`${host}: missing case identity`);
    }
  }
  const webRows = web.runs[0].results, nativeRows = native.runs[0].results;
  for (const row of nativeRows) for (const id of families) {
    const peer = webRows.find(candidate => key(candidate) === key({ ...row, id }));
    if (id === families[2] && row.libraryHash !== peer.libraryHash) throw Error("Actual Native CSM sampling source differs between hosts");
    const error = row.values.reduce((max, value, i) => Math.max(max, Math.abs(value - peer.values[i])), 0);
    if (error > fixture.maxError) throw Error("Actual Native/Chrome CSM sample drift");
    crossHostMaxError = Math.max(crossHostMaxError, error);
    if (row.filter === "linear" && row.pattern === "edge") {
      const nearest = nativeRows.find(candidate => key(candidate) === key({ ...row, filter: "nearest" }));
      linearNearestDifference = Math.max(linearNearestDifference, ...row.values.map((value, i) => Math.abs(value - nearest.values[i])));
    }
  }
  if (linearNearestDifference <= .05) throw Error("Fixture did not distinguish real linear vs nearest PCF filtering");
  return { passed: true, fixtureHash, cpuMaxError, crossHostMaxError, linearNearestDifference,
    casesPerFamily: cases.length, pointsPerCase: points.length, rounds: 2,
    samples: { chrome: cases.length * points.length * families.length * 2, native: cases.length * points.length * 2 },
    sourceIdentities: { chrome: webRows.map(({ id, sourceHash, libraryHash }) => ({ id, sourceHash, libraryHash })),
      native: nativeRows.map(({ sourceHash, libraryHash }) => ({ sourceHash, libraryHash })) },
    scope: "actual-native-wgpu-and-three-chrome-csm-functions-linear-pcf-edge",
    excluded: ["other physical GPU devices", "full CSM scene/camera/planner", "GPU timing/VRAM"] };
}
