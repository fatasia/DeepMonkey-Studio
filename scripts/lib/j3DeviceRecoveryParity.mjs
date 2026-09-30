export function compareDeviceRecovery(manifest, web, native) {
  for (const [name, leg] of [["web", web], ["native", native]]) {
    if (!leg || leg.passed !== true || leg.runs?.length !== 2) throw Error(`${name}: missing two successful real-host runs`);
    if (leg.packageHash !== manifest.packageHash || leg.packetHash !== manifest.packetHash)
      throw Error(`${name}: recovery manifest identity mismatch`);
    for (const run of leg.runs) {
      if (JSON.stringify(run.phases) !== JSON.stringify(manifest.phases)) throw Error(`${name}: phase contract mismatch`);
      if (run.lossReason !== "destroyed" || run.newDevice !== true || run.firstFrameValid !== true
        || run.firstFrameStable !== true || run.liveComponentsAtLoss !== true || run.maxError !== 0 || !(run.coloredPixels > 32))
        throw Error(`${name}: actual loss/recreation/valid first-frame proof missing`);
      if (name === "web" && (run.resourcesAfter !== 0 || run.ownedEstimatedBytesAfter !== 0))
        throw Error("web: managed resource ownership did not return to zero");
    }
    if (leg.runs[0].coloredPixels !== leg.runs[1].coloredPixels) throw Error(`${name}: repeated first-frame coverage drift`);
  }
  return { passed: true, packageHash: manifest.packageHash, packetHash: manifest.packetHash,
    phases: manifest.phases, runsPerHost: 2, phaseSamplesPerHost: manifest.phases.length * 2,
    scope: "Actual destroyed-device reopen + production renderer components; within-host first-frame identity",
    excluded: ["automatic unknown-loss recovery", "NativeApp window event routing/present", "cross-host pixels",
      "physical driver VRAM", "GPU timing", "full editor state recovery"] };
}
