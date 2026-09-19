/**
 * Mainline closure evidence index for the 2026-09-18 handoff.
 *
 * This is deliberately an evidence checker, not a score generator: a known
 * blocked/deferred lane is reported as such and never converted into a pass.
 * It only reads committed/locally generated evidence and writes one small,
 * reproducible JSON index under test-output.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateGiClosureMatrix, GI_CLOSURE_THRESHOLDS } from "./lib/giClosureEvidence.mjs";
import { validateProjectPostAcceptanceCards } from "./lib/projectPostAcceptanceEvidence.mjs";
import { evaluateIndustrialStageDelta } from "./lib/industrialStageDeltaEvidence.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.resolve(process.env.MAINLINE_CLOSURE_OUTPUT ?? path.join(root, "test-output", "mainline-closure-20260918"));
const fatal = [];
const results = [];

async function readJson(relativePath, required = true) {
  const file = path.join(root, relativePath);
  try {
    return { value: JSON.parse(await readFile(file, "utf8")), file };
  } catch (error) {
    if (!required && error?.code === "ENOENT") return { value: undefined, file };
    fatal.push(`${relativePath}: ${error.message}`);
    return { value: undefined, file };
  }
}

async function readText(relativePath, required = true) {
  const file = path.join(root, relativePath);
  try {
    return { value: await readFile(file, "utf8"), file };
  } catch (error) {
    if (!required && error?.code === "ENOENT") return { value: undefined, file };
    fatal.push(`${relativePath}: ${error.message}`);
    return { value: undefined, file };
  }
}

async function fingerprint(file) {
  const bytes = await readFile(file);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function add(id, status, evidence, checks, gaps = []) {
  results.push({ id, status, evidence, checks, gaps });
}

function same(values) {
  return values.length > 0 && values.every((value) => value === values[0]);
}

async function checkClipping() {
  const relative = "test-output/scene-clipping-e2e-20260918-r3/evidence.json";
  const { value, file } = await readJson(relative);
  if (!value) return;
  const clipped = value.cells?.find((cell) => cell.variant === "clipped");
  const open = value.cells?.find((cell) => cell.variant === "open");
  const repeated = [clipped, open].every((cell) => same((cell?.captures ?? []).map((capture) => capture.clientRgbaSha256)));
  const changed = Number(value.changedBytes);
  const passed = Boolean(clipped && open && repeated && clipped.captures?.[0]?.clientRgbaSha256 !== open.captures?.[0]?.clientRgbaSha256 && changed > 10_000);
  add("01-clipping-e2e", passed ? "passed" : "unverified", [{ path: relative, ...(await fingerprint(file)) }], {
    repeatedClientPixels: repeated,
    clippedVsOpenDifferent: passed && clipped.captures[0].clientRgbaSha256 !== open.captures[0].clientRgbaSha256,
    changedBytes: changed,
    compiledPlane: clipped?.camera?.clippingPlane ?? null,
  }, passed ? [] : ["real Native clipping evidence is incomplete or not deterministic"]);
}

async function checkDynamicRuntime() {
  const relative = "docs/specs/dynamic-scene-runtime-audit-2026-09-18.md";
  const { value, file } = await readText(relative);
  if (!value) return;
  const bounded = /deferred/i.test(value) && /Runtime Package/i.test(value) && /Native/i.test(value);
  const [types, builder, nativePayloads, nativePlayerContent, nativeConsumerTest, webConsumer, webConsumerTest] = await Promise.all([
    readText("packages/deep-engine/src/runtimePackage/types.ts"),
    readText("packages/deep-engine/src/runtimePackage/builder.ts"),
    readText("packages/deep-engine-native/src/runtime_package/payloads.rs"),
    readText("packages/deep-engine-native/src/player_content.rs"),
    readText("packages/deep-engine-native/src/player_content_chart_package_tests.rs"),
    readText("apps/web/src/delivery/dynamicRuntimePlayback.ts"),
    readText("apps/web/src/delivery/dynamicRuntimePlayback.test.ts"),
  ]);
  const formalResource = /dynamic-runtime/.test(types.value ?? "") && /dynamicRuntime/.test(builder.value ?? "")
    && /dynamic_runtime/.test(nativePayloads.value ?? "");
  const nativePlayerContentConsumer = /dynamic_runtime/.test(nativePlayerContent.value ?? "") && /v7_dynamic_runtime_is_carried/.test(nativeConsumerTest.value ?? "");
  const webFrameConsumer = /sampleDynamicRuntimePackage/.test(webConsumer.value ?? "")
    && /applyDynamicRuntimeFrame/.test(webConsumer.value ?? "")
    && /samples compiled v7 tracks/.test(webConsumerTest.value ?? "")
    && /applies one sampled frame/.test(webConsumerTest.value ?? "");
  // 2026-09-19 playback round: real-window WebGPU/WebGL/Native replay evidence.
  const playbackRelative = "test-output/dynamic-runtime-20260919-r1/evidence.json";
  const { value: playback } = await readJson(playbackRelative, false);
  const playbackDoc = await readText("docs/specs/dynamic-scene-runtime-playback-2026-09-19.md", false);
  const playbackDeterministic = Boolean(playback?.determinism
    && Object.entries(playback.determinism).filter(([key]) => key !== "crossEndDigestReference").every(([, passed]) => passed === true));
  const roundsComplete = Boolean(playback
    && Array.isArray(playback.native) && playback.native.length >= 2
    && playback.native.every((round) => round.clock === "real-window" && round.steps?.length === playback.frozenPackage?.totalSteps)
    && ["webgl", "webgpu"].every((backend) => {
      const rounds = playback.web?.[backend];
      return Array.isArray(rounds) && rounds.length >= 2
        && rounds.every((round) => round.steps?.length === playback.frozenPackage?.totalSteps && round.presentations?.length >= 1);
    })
    && playback.native.every((round) => round.presentations?.length >= 1));
  const playbackClosed = playbackDeterministic && roundsComplete
    && Boolean(playbackDoc.value)
    && Boolean(playback?.frozenPackage?.dynamicChannels?.animation && playback?.frozenPackage?.dynamicChannels?.dataReplay
      && playback?.frozenPackage?.dynamicChannels?.interaction);
  const status = playbackClosed ? "passed" : formalResource ? "partial" : bounded ? "bounded-deferred" : "unverified";
  const evidence = [{ path: relative, ...(await fingerprint(file)) },
    ...(formalResource ? [
      { path: "packages/deep-engine/src/runtimePackage/types.ts", ...(await fingerprint(types.file)) },
      { path: "packages/deep-engine/src/runtimePackage/builder.ts", ...(await fingerprint(builder.file)) },
      { path: "packages/deep-engine-native/src/runtime_package/payloads.rs", ...(await fingerprint(nativePayloads.file)) },
      ...(nativePlayerContent.value ? [{ path: "packages/deep-engine-native/src/player_content.rs", ...(await fingerprint(nativePlayerContent.file)) }] : []),
      ...(nativeConsumerTest.value ? [{ path: "packages/deep-engine-native/src/player_content_chart_package_tests.rs", ...(await fingerprint(nativeConsumerTest.file)) }] : []),
      ...(webFrameConsumer ? [
        { path: "apps/web/src/delivery/dynamicRuntimePlayback.ts", ...(await fingerprint(webConsumer.file)) },
        { path: "apps/web/src/delivery/dynamicRuntimePlayback.test.ts", ...(await fingerprint(webConsumerTest.file)) },
      ] : []),
    ] : []),
    ...(playbackDoc.value ? [{ path: "docs/specs/dynamic-scene-runtime-playback-2026-09-19.md", ...(await fingerprint(playbackDoc.file)) }] : []),
    ...(playback ? [{ path: playbackRelative, ...(await fingerprint(path.join(root, playbackRelative))) }] : [])];
  const playbackChecks = playback ? {
    frozenPackageSha256: playback.frozenPackage?.sha256 ?? null,
    totalSteps: playback.frozenPackage?.totalSteps ?? null,
    determinism: playback.determinism ?? null,
    nativeRealWindowRounds: Array.isArray(playback.native) ? playback.native.length : 0,
    webRealBrowserRounds: Object.fromEntries(["webgl", "webgpu"].map((backend) => [backend, Array.isArray(playback.web?.[backend]) ? playback.web[backend].length : 0])),
  } : null;
  add("02-dynamic-scene-runtime-package", status, evidence, {
    dynamicFields: ["animation", "dataBindings", "interactions"],
    explicitDeferredBoundary: bounded,
    formalResource,
    nativeDecodeConsumer: formalResource,
    nativePlayerContentConsumer,
    webFrameConsumer,
    playback: playbackChecks,
  }, playbackClosed ? ["non-object-TRS animation channels (camera/clip), enabled live dataBindings and script interactions remain deferred until their consumers exist"]
    : formalResource ? [webFrameConsumer
      ? "Web package sampling/frame application is covered by a compile-to-consumer test; WebGPU frame playback, Native real-window playback and deterministic cross-end replay remain deferred"
      : "formal v7 resource/decode and Native PlayerContent consumption exist; WebGPU frame playback and real-window evidence remain deferred"]
    : bounded ? ["non-empty dynamic fields remain deferred until a versioned offline ABI and Native/Web consumers exist"] : ["dynamic runtime boundary is not documented"]);
}

async function checkNature() {
  const auditRelative = "test-output/de26-v11-nature-review-20260918/geometry-units-thumbnail-audit.json";
  const manifestRelative = "docs/specs/de26-v11-kenney-nature-admission-manifest-2026-09-18.json";
  const groundedRelative = "test-output/de26-v11-nature-review-20260918/grounded-derived-evidence.json";
  const catalogRelative = "apps/web/public/assets/nature-kit/catalog.json";
  const productReportRelative = "test-output/asset-material-flow/report.json";
  const { value: audit, file: auditFile } = await readJson(auditRelative);
  const { value: manifest, file: manifestFile } = await readJson(manifestRelative);
  const { value: grounded, file: groundedFile } = await readJson(groundedRelative, false);
  const { value: catalog, file: catalogFile } = await readJson(catalogRelative, false);
  const { value: productReport, file: productReportFile } = await readJson(productReportRelative, false);
  if (!audit || !manifest) return;
  const hashMatch = audit.archiveSha256 === manifest.archive.sha256;
  const countMatch = audit.selectedCounts?.total === manifest.selection.total;
  const rawOutlier = audit.selectedGeometry?.origin?.outlier;
  const groundedGate = grounded?.grounded === true && grounded?.rawMinY >= -0.001;
  const stagedCatalog = catalog?.schema === "deep-engine.v11-nature-kit-catalog" && catalog.selectedCount === 48 && catalog.entries?.length === 48;
  const blocked = groundedGate ? null : rawOutlier;
  const product = { ...(audit.productValidation ?? {}), ...(productReport?.productValidation ?? {}) };
  const ready = hashMatch && countMatch && !blocked && product.inProductDragDrop === "verified" && product.saveRefreshReopen === "verified";
  const sceneInsertion = productReport?.steps?.find((step) => step.id === "insert-model-to-scene" && step.persisted === true);
  const persistence = productReport?.steps?.find((step) => step.id === "reload-restores-scene-model" && step.persisted === true);
  const productSlice = sceneInsertion && persistence && productReport?.productValidation?.saveRefreshReopen === "verified";
  add("03-v11-nature-kit", ready ? "passed" : productSlice && groundedGate ? "partial" : "blocked", [
    { path: auditRelative, ...(await fingerprint(auditFile)) },
    { path: manifestRelative, ...(await fingerprint(manifestFile)) },
    ...(grounded ? [{ path: groundedRelative, ...(await fingerprint(groundedFile)) }] : []),
    ...(catalog ? [{ path: catalogRelative, ...(await fingerprint(catalogFile)) }] : []),
    ...(productReport ? [{ path: productReportRelative, ...(await fingerprint(productReportFile)) }] : []),
  ], {
    archiveSha256: audit.archiveSha256,
    selectedTemplates: audit.selectedCounts?.total ?? 0,
    selectedMissingThumbnails: audit.thumbnailAudit?.selectedMissingIsometricViews ?? null,
    groundedOriginOutlier: blocked ?? null,
    groundedDerivedGate: groundedGate,
    stagedCatalog,
    productDragDrop: product.inProductDragDrop ?? "unverified",
    saveRefreshReopen: product.saveRefreshReopen ?? "unverified",
    sceneInsertion: sceneInsertion ?? null,
    sceneModelReload: persistence ?? null,
    browserNatureImport: productReport?.steps?.find((step) => step.id === "v11-nature-kit-import") ?? null,
  }, ready ? [] : productSlice && groundedGate ? ["catalog import, scene insertion and reload persistence verified; drag/drop gesture evidence remains"] : [groundedGate ? "in-product drag/drop and persistence are not verified" : "fence_gate.glb is below the grounded-origin threshold or in-product drag/drop and persistence are not verified"]);
}

async function checkOsPublication() {
  const sceneRelative = "test-output/scene-standalone-executable-20260918/evidence.json";
  const pixelRelative = "test-output/scene-standalone-executable-20260918/pixel-evidence.json";
  const offlineRelative = "test-output/scene-publish-offline-20260918-main/evidence.json";
  const preflightRelative = "test-output/scene-publish-offline-20260919-os-preflight/evidence.json";
  const { value: scene, file: sceneFile } = await readJson(sceneRelative);
  const { value: pixels, file: pixelFile } = await readJson(pixelRelative);
  const { value: offline, file: offlineFile } = await readJson(offlineRelative);
  const { value: preflight, file: preflightFile } = await readJson(preflightRelative, false);
  if (!scene || !pixels || !offline) return;
  const captureCount = scene.captures?.length === 4;
  const pixelStable = pixels.identicalClientPixels === true && same((pixels.pixels ?? []).map((item) => item.clientRgbaSha256));
  const isolatedStarts = (offline.isolatedStartup ?? []).length === 6 && offline.isolatedStartup.every((item) => item.exit === 0);
  const apiStopped = scene.offline === "API stopped, no arguments, no runtime sidecar";
  const passed = captureCount && pixelStable && isolatedStarts && apiStopped;
  add("04-publish-chain-os-evidence", passed ? "passed" : "unverified", [
    { path: sceneRelative, ...(await fingerprint(sceneFile)) },
    { path: pixelRelative, ...(await fingerprint(pixelFile)) },
    { path: offlineRelative, ...(await fingerprint(offlineFile)) },
    ...(preflight ? [{ path: preflightRelative, ...(await fingerprint(preflightFile)) }] : []),
  ], {
    fourWindowCaptures: captureCount,
    identicalClientPixels: pixelStable,
    apiStoppedNoSidecar: apiStopped,
    isolatedStartupRuns: offline.isolatedStartup?.length ?? 0,
    firewallExit: offline.firewall?.exit ?? null,
    hostFirewallPreflight: preflight ? { stateExit: preflight.state?.exit, policyExit: preflight.policy?.exit, readOnly: preflight.readOnly } : null,
  }, passed ? [] : ["published EXE/OS evidence is incomplete"]);
}

async function checkGi() {
  const nativeRelative = "test-output/native-baked-gi-20260918-r2/evidence.json";
  const matrixRelative = "test-output/gi-crossend-matrix-20260919-r14/matrix.json";
  const { value: native, file: nativeFile } = await readJson(nativeRelative);
  const { value: matrix, file: matrixFile } = await readJson(matrixRelative);
  if (!native || !matrix) return;
  const nativeStable = native.evidence?.every((item) => same((item.captures ?? []).map((capture) => capture.clientRgbaSha256))) && native.changedChannels > 1_000;
  const matrixEvaluation = evaluateGiClosureMatrix(matrix);
  const matrixPass = matrixEvaluation.passed;
  add("05-gi-cross-end", nativeStable && matrixPass ? "passed" : "partial", [
    { path: nativeRelative, ...(await fingerprint(nativeFile)) },
    { path: matrixRelative, ...(await fingerprint(matrixFile)) },
  ], {
    nativeBakeChanges: native.changedChannels,
    nativeRepeatStable: nativeStable,
    crossEndThresholdPass: matrixPass,
    crossEndMatrixComplete: matrixEvaluation.complete,
    crossEndThresholds: GI_CLOSURE_THRESHOLDS,
    crossEndCells: matrixEvaluation.cells,
  }, matrixPass ? [] : ["Native bake consumption is stable, but the current WebGPU↔Native cross-end matrix remains below the structural/normalized threshold"]);
}

async function checkProjectPostAcceptance() {
  const closureRelative = "docs/specs/deep-engine-mainline-closure-recheck-2026-09-18.md";
  const pairedRelative = "docs/specs/de26-a04-a08-paired-runtime-2026-09-18.md";
  const boundRelative = "test-output/d24-d28-evidence-20260919/evidence.json";
  const { value: closure, file: closureFile } = await readText(closureRelative);
  const { value: paired, file: pairedFile } = await readText(pairedRelative);
  const { value: bound, file: boundFile } = await readJson(boundRelative, false);
  if (!closure || !paired) return;
  const hasD24toD28 = /D24[–-]D28/.test(closure) && /项目后验收/.test(closure);
  const hasCaveats = /仍需关闭|未完成|不能/.test(closure) && /剩余/.test(paired);
  let postAcceptanceCards;
  let boundEvidence = null;
  if (bound?.schema === "deep-engine.d24-d28-project-post-acceptance.v2" && Array.isArray(bound.postAcceptanceCards)) {
    postAcceptanceCards = bound.postAcceptanceCards.map((card) => ({
      id: card.id,
      status: card.status,
      reason: card.reason,
      ...(card.independentEvidence === undefined ? {} : { independentEvidence: card.independentEvidence }),
    }));
    boundEvidence = {
      verdict: bound.verdict,
      checks: bound.checks ?? {},
      bindingCount: (bound.bindings ?? []).length,
      soakMeasuredMinutes: Math.max(0, ...(bound.runs?.soak ?? []).map((soak) => soak.measuredMinutes ?? 0)),
      cardReasons: bound.postAcceptanceCards.map((card) => ({ id: card.id, status: card.status, reason: card.reason })),
    };
  } else {
    postAcceptanceCards = [
      { id: "V01", status: /Three|Babylon/.test(paired) ? "partial" : "unverified", reason: "Web paired evidence covers fixed Deep/Three cases, not the full opponent matrix" },
      { id: "V02", status: "unverified", reason: "independent Native opponent runs are not present in this evidence set" },
      { id: "V03", status: /scene-standalone-executable|故障/.test(closure) ? "partial" : "unverified", reason: "publication/recovery evidence exists; full fault matrix remains" },
      { id: "V04", status: /design-taste-digitaltwin|视觉/.test(paired) ? "partial" : "unverified", reason: "benchmark visual review is not the complete product visual and accessibility gate" },
      { id: "V05", status: "unverified", reason: "no independent synthesis sign-off may be inferred from component reports" },
    ];
  }
  const cardContract = validateProjectPostAcceptanceCards(postAcceptanceCards);
  const allPassed = cardContract.valid && postAcceptanceCards.every((card) => card.status === "passed");
  const status = hasD24toD28 ? (allPassed ? "passed" : "partial") : "unverified";
  const remaining = postAcceptanceCards.filter((card) => card.status !== "passed");
  const gaps = !hasD24toD28
    ? ["D24–D28 project post-acceptance scope is not mapped in the closure recheck document"]
    : allPassed
      ? []
      : [remaining.map((card) => `${card.id}(${card.status}): ${card.reason}`).join(" | ")];
  const evidence = [
    { path: closureRelative, ...(await fingerprint(closureFile)) },
    { path: pairedRelative, ...(await fingerprint(pairedFile)) },
  ];
  if (bound) {
    evidence.push({ path: boundRelative, ...(await fingerprint(boundFile)) });
    for (const binding of bound.bindings ?? []) {
      if (!binding.path || !binding.path.startsWith(root)) continue;
      const relativeBinding = path.relative(root, binding.path);
      evidence.push({ path: relativeBinding, ...(await fingerprint(path.join(root, relativeBinding))) });
    }
  }
  add("06-d24-d28-project-post-acceptance", status, evidence, {
    mappedPostAcceptanceScope: hasD24toD28,
    explicitCaveats: hasCaveats,
    cardContract,
    pairedCases: (paired.match(/^\|[^\n]+\|/gm) ?? []).length,
    postAcceptanceCards,
    boundEvidence,
  }, gaps);
}

async function checkIndustrial() {
  const relative = "docs/specs/industrial-stage-delta-2026-09-18.md";
  const matrixRelative = "docs/specs/industrial-s1-s6-acceptance-matrix-2026-09-18.json";
  const { value, file } = await readText(relative);
  const { value: matrix, file: matrixFile } = await readJson(matrixRelative, false);
  if (!value) return;
  const { stages, completeStageMatrix: completeMatrix, explicitGaps } = evaluateIndustrialStageDelta(value);
  const machineStages = Array.isArray(matrix?.stages) ? matrix.stages : [];
  const machineProfiles = Array.isArray(matrix?.profiles) ? matrix.profiles : [];
  const matrixValid = machineStages.length === 6 && machineProfiles.length === 7;
  const stageClosingStatuses = new Set(["complete", "passed"]);
  const stagesComplete = matrixValid && machineStages.every((stage) => stageClosingStatuses.has(stage.status));
  const profilesReady = matrixValid && machineProfiles.every((profile) => profile.productionReady === true);
  const allComplete = stagesComplete && profilesReady;
  const remainingStages = machineStages.filter((stage) => !stageClosingStatuses.has(stage.status));
  const remainingProfiles = machineProfiles.filter((profile) => profile.productionReady !== true);
  add("07-industrial-s1-s6", allComplete ? "passed" : "partial", [
    { path: relative, ...(await fingerprint(file)) },
    ...(matrix ? [{ path: matrixRelative, ...(await fingerprint(matrixFile)) }] : []),
  ], {
    stages,
    completeStageMatrix: completeMatrix,
    explicitGaps,
    machineMatrix: matrix ? {
      validShape: matrixValid,
      stageStatuses: machineStages.map((stage) => ({ id: stage.id, status: stage.status })),
      profileStatuses: machineProfiles.map((profile) => ({ id: profile.id, quality: profile.quality, productionReady: profile.productionReady })),
      stagesComplete,
      profilesReady,
    } : null,
    remainingStageGaps: remainingStages.map((stage) => ({ id: stage.id, status: stage.status })),
    remainingProfileGaps: remainingProfiles.map((profile) => ({ id: profile.id, quality: profile.quality, reason: profile.reason })),
  }, allComplete
    ? []
    : [`${remainingStages.length} of 6 stages incomplete (${remainingStages.map((stage) => `${stage.id}:${stage.status}`).join(", ") || "none"}); ${remainingProfiles.length} of 7 profiles below productionReady`]);
}

async function checkAssetReadiness() {
  const readinessRelative = "test-output/de26-local-assets-readiness-20260918/readiness.json";
  const evidenceRelative = "test-output/de26-local-assets-readiness-20260918/readiness-evidence.json";
  const sourceAuditRelative = "test-output/de26-rvt-source-audit-20260919-r4/evidence.json";
  const reportRelative = "docs/reports/de26-asset-readiness-2026-09-18.md";
  const { value: readiness, file: readinessFile } = await readJson(readinessRelative);
  const { value: evidence, file: evidenceFile } = await readJson(evidenceRelative, false);
  const { value: sourceAudit, file: sourceAuditFile } = await readJson(sourceAuditRelative, false);
  const { value: report, file: reportFile } = await readText(reportRelative);
  if (!readiness || !report) return;
  const blockedChecks = (readiness.checks ?? []).filter((check) => check.status === "blocked");
  const unverifiedAssets = (readiness.assets ?? []).filter((asset) => asset.status === "unverified");
  const measuredSources = (readiness.assets ?? []).every((asset) => asset.source?.status === "measured");
  const status = readiness.status === "measured" && blockedChecks.length === 0 && unverifiedAssets.length === 0
    ? "passed" : "partial";
  add("08-de26-asset-readiness", status, [
    { path: readinessRelative, ...(await fingerprint(readinessFile)) },
    ...(evidence ? [{ path: evidenceRelative, ...(await fingerprint(evidenceFile)) }] : []),
    ...(sourceAudit ? [{ path: sourceAuditRelative, ...(await fingerprint(sourceAuditFile)) }] : []),
    { path: reportRelative, ...(await fingerprint(reportFile)) },
  ], {
    declaredStatus: readiness.status,
    measuredSources,
    blockedChecks: blockedChecks.map((check) => check.id),
    unverifiedAssets: unverifiedAssets.map((asset) => asset.id),
    requiredLoadClasses: readiness.requiredLoadClasses ?? [],
    evidencePacket: evidence ? {
      schema: evidence.schema ?? null,
      loadClassRatio: evidence.coverage?.loadClasses?.ratio ?? null,
      taskKindRatio: evidence.coverage?.taskKinds?.ratio ?? null,
      gapCount: Array.isArray(evidence.gaps) ? evidence.gaps.length : null,
      derivedStatisticsAuthoritative: evidence.derivedStatistics?.authoritative ?? null,
      sourceRvtAudit: sourceAudit ? {
        scope: sourceAudit.scope ?? null,
        resultCount: Array.isArray(sourceAudit.results) ? sourceAudit.results.length : 0,
        unsupportedVersions: Array.isArray(sourceAudit.results) ? sourceAudit.results.filter((item) => item.status === "unsupported-version").length : 0,
      } : null,
    } : null,
  }, status === "passed" ? [] : [
    ...(blockedChecks.length ? ["DE26 readiness still has blocked checks"] : []),
    ...(unverifiedAssets.length ? ["DE26 readiness still lacks exact source-level geometry/material statistics for some assets"] : []),
  ]);
}

await checkClipping();
await checkDynamicRuntime();
await checkNature();
await checkOsPublication();
await checkGi();
await checkProjectPostAcceptance();
await checkIndustrial();
await checkAssetReadiness();

await mkdir(outputDirectory, { recursive: true });
const output = {
  schema: "deep-monkey.mainline-closure",
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit: (process.env.GIT_COMMIT ?? "working-tree"),
  contractValid: fatal.length === 0 && results.length === 8,
  fatalIssues: fatal,
  results,
  summary: Object.fromEntries(["passed", "passed-with-boundary", "partial", "bounded-deferred", "blocked", "unverified"].map((status) => [status, results.filter((item) => item.status === status).length])),
};
const outputPath = path.join(outputDirectory, "closure.json");
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
assert.equal(output.contractValid, true, `mainline closure evidence contract invalid: ${fatal.join("; ") || "missing lane result"}`);
console.log(JSON.stringify({ output: outputPath, summary: output.summary }, null, 2));
