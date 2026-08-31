import { createEvidenceFingerprint, EVIDENCE_FINGERPRINT_ALGORITHM } from "./evidenceFingerprint.js";

export interface SmartBindingPosition {
  x: number;
  y: number;
  z?: number;
}

export interface SmartBindingSceneObject {
  id: string;
  name: string;
  path?: string;
  category?: string;
  properties?: Readonly<Record<string, unknown>>;
  position?: SmartBindingPosition;
}

export interface SmartBindingCatalogItem {
  deviceId: string;
  name: string;
  tags?: readonly string[];
  space?: string;
  category?: string;
  position?: SmartBindingPosition;
}

export type SmartBindingFactorName = "stable-identifier" | "name" | "space" | "category" | "distance";

export interface SmartBindingEvidenceFactor {
  factor: SmartBindingFactorName;
  score: number;
  weight: number;
  contribution: number;
  available: boolean;
  explanation: string;
}

export interface SmartBindingCandidate {
  sceneObjectId: string;
  deviceId: string;
  confidence: number;
  recommendation: "strong-candidate" | "review-candidate";
  requiresHumanConfirmation: true;
  evidence: SmartBindingEvidenceFactor[];
}

export interface SmartBindingConflict {
  type: "device-contended" | "scene-ambiguous";
  sceneObjectIds: string[];
  deviceIds: string[];
  resolvedSceneObjectId?: string;
  resolvedDeviceId?: string;
  explanation: string;
}

export interface SmartBindingUnmatchedSceneObject {
  sceneObjectId: string;
  bestConfidence: number;
  reason: "no-candidate" | "lost-one-to-one-conflict";
}

export interface SmartAssetBindingResult {
  generatedBy: "deterministic-multi-factor-v1";
  requiresHumanConfirmation: true;
  candidates: SmartBindingCandidate[];
  conflicts: SmartBindingConflict[];
  unmatchedSceneObjects: SmartBindingUnmatchedSceneObject[];
  unmatchedDeviceIds: string[];
  evidenceFingerprint: string;
  fingerprintAlgorithm: typeof EVIDENCE_FINGERPRINT_ALGORITHM;
}

export interface SmartAssetBindingOptions {
  minimumConfidence?: number;
  strongConfidence?: number;
  ambiguityDelta?: number;
  distanceScale?: number;
}

interface ScoredPair {
  sceneObjectId: string;
  deviceId: string;
  confidence: number;
  evidence: SmartBindingEvidenceFactor[];
}

const FACTOR_WEIGHTS: Readonly<Record<SmartBindingFactorName, number>> = {
  "stable-identifier": 0.42,
  name: 0.28,
  space: 0.1,
  category: 0.08,
  distance: 0.12,
};

const STABLE_PROPERTY_KEYS = [
  "deviceid", "device_id", "assetid", "asset_id", "equipmentid", "equipment_id",
  "externalid", "external_id", "code", "tag", "uuid", "guid",
] as const;

/**
 * 生成可解释的一对一候选绑定。结果是确定性建议，不会替用户确认或写回场景。
 * 调用方应在用户确认后再生成真正的数据绑定命令。
 */
export function proposeSmartAssetBindings(
  sceneObjects: readonly SmartBindingSceneObject[],
  catalog: readonly SmartBindingCatalogItem[],
  options: SmartAssetBindingOptions = {},
): SmartAssetBindingResult {
  assertUniqueIds(sceneObjects, catalog);
  const minimumConfidence = boundedOption(options.minimumConfidence, 0.45, "minimumConfidence");
  const strongConfidence = boundedOption(options.strongConfidence, 0.78, "strongConfidence");
  const ambiguityDelta = boundedOption(options.ambiguityDelta, 0.08, "ambiguityDelta");
  const distanceScale = positiveOption(options.distanceScale, 50, "distanceScale");
  if (strongConfidence < minimumConfidence) throw new Error("strongConfidence 不能低于 minimumConfidence");

  const pairs = sceneObjects.flatMap((scene) => catalog.map((item) => scorePair(scene, item, distanceScale)));
  const rankedByScene = new Map(sceneObjects.map((scene) => [scene.id, pairs
    .filter((pair) => pair.sceneObjectId === scene.id)
    .sort(comparePairs)]));
  const eligiblePairs = pairs.filter((pair) => pair.confidence >= minimumConfidence).sort(comparePairs);
  const assignments = resolveOneToOne(eligiblePairs);
  const conflicts = detectConflicts(rankedByScene, assignments, minimumConfidence, ambiguityDelta);
  const candidates = assignments.map((pair) => {
    const alternatives = rankedByScene.get(pair.sceneObjectId) ?? [];
    const nextBest = alternatives.find((candidate) => candidate.deviceId !== pair.deviceId)?.confidence ?? 0;
    const recommendation = pair.confidence >= strongConfidence && pair.confidence - nextBest >= ambiguityDelta
      ? "strong-candidate" as const : "review-candidate" as const;
    return {
      sceneObjectId: pair.sceneObjectId,
      deviceId: pair.deviceId,
      confidence: pair.confidence,
      recommendation,
      requiresHumanConfirmation: true as const,
      evidence: pair.evidence,
    };
  }).sort(compareMappings);
  const assignedScenes = new Set(candidates.map((candidate) => candidate.sceneObjectId));
  const assignedDevices = new Set(candidates.map((candidate) => candidate.deviceId));
  const contendedScenes = new Set(conflicts
    .filter((conflict) => conflict.type === "device-contended")
    .flatMap((conflict) => conflict.sceneObjectIds));
  const unmatchedSceneObjects = [...sceneObjects]
    .filter((scene) => !assignedScenes.has(scene.id))
    .sort(compareById)
    .map((scene) => ({
      sceneObjectId: scene.id,
      bestConfidence: rankedByScene.get(scene.id)?.[0]?.confidence ?? 0,
      reason: contendedScenes.has(scene.id) ? "lost-one-to-one-conflict" as const : "no-candidate" as const,
    }));
  const unmatchedDeviceIds = [...catalog]
    .filter((item) => !assignedDevices.has(item.deviceId))
    .map((item) => item.deviceId)
    .sort(compareText);

  const resultBase = {
    generatedBy: "deterministic-multi-factor-v1" as const,
    requiresHumanConfirmation: true as const,
    candidates,
    conflicts,
    unmatchedSceneObjects,
    unmatchedDeviceIds,
  };
  return {
    ...resultBase,
    evidenceFingerprint: createEvidenceFingerprint({
      sceneObjects: [...sceneObjects].sort(compareById),
      catalog: [...catalog].sort((left, right) => compareText(left.deviceId, right.deviceId)),
      options: { minimumConfidence, strongConfidence, ambiguityDelta, distanceScale },
      result: resultBase,
    }),
    fingerprintAlgorithm: EVIDENCE_FINGERPRINT_ALGORITHM,
  };
}

function scorePair(scene: SmartBindingSceneObject, item: SmartBindingCatalogItem, distanceScale: number): ScoredPair {
  const stableScore = stableIdentifierScore(scene, item);
  const nameScore = textSimilarity(scene.name, item.name);
  const sceneSpace = sceneSpaceValue(scene);
  const distance = positionDistance(scene.position, item.position);
  const factors: SmartBindingEvidenceFactor[] = [
    factor("stable-identifier", stableScore.score, stableScore.available, stableScore.explanation),
    factor("name", nameScore, Boolean(normalizeText(scene.name) && normalizeText(item.name)), `名称相似度 ${format(nameScore)}`),
    comparableTextFactor("space", sceneSpace, item.space),
    comparableTextFactor("category", scene.category ?? propertyText(scene.properties, ["category", "type", "kind"]), item.category),
    factor("distance", distance === undefined ? 0 : Math.max(0, 1 - distance / distanceScale), distance !== undefined,
      distance === undefined ? "缺少双方坐标" : `空间距离 ${format(distance)}`),
  ];
  const available = factors.filter((item) => item.available);
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const weightedAverage = availableWeight > 0
    ? available.reduce((sum, item) => sum + item.contribution, 0) / availableWeight : 0;
  const coverageReliability = 0.65 + availableWeight * 0.35;
  let confidence = weightedAverage * coverageReliability;
  // 精确稳定标识是唯一允许压过名称与位置噪声的硬证据。
  if (stableScore.score === 1) confidence = Math.max(confidence, 0.99);
  return {
    sceneObjectId: scene.id,
    deviceId: item.deviceId,
    confidence: round01(confidence),
    evidence: factors,
  };
}

function stableIdentifierScore(
  scene: SmartBindingSceneObject,
  item: SmartBindingCatalogItem,
): { score: number; available: boolean; explanation: string } {
  const sceneIdentifiers = stableSceneIdentifiers(scene);
  const sceneValues = sceneIdentifiers.values;
  const itemValues = [item.deviceId, ...(item.tags ?? [])].map(normalizeIdentifier).filter(Boolean);
  if (sceneValues.length === 0 || itemValues.length === 0) return { score: 0, available: false, explanation: "缺少稳定标识" };
  if (sceneValues.some((value) => itemValues.includes(value))) return { score: 1, available: true, explanation: "稳定标识精确一致" };
  const partial = sceneValues.some((left) => itemValues.some((right) => left.length >= 5 && right.length >= 5 && (left.includes(right) || right.includes(left))));
  return partial
    ? { score: 0.65, available: true, explanation: "稳定标识存在受控包含关系" }
    : sceneIdentifiers.hasExplicit
      ? { score: 0, available: true, explanation: "显式稳定标识不一致" }
      : { score: 0, available: false, explanation: "场景仅有内部 ID，不能作为否定证据" };
}

function stableSceneIdentifiers(scene: SmartBindingSceneObject): { values: string[]; hasExplicit: boolean } {
  const properties = scene.properties ?? {};
  const explicit = Object.entries(properties)
    .filter(([key]) => STABLE_PROPERTY_KEYS.includes(normalizeKey(key) as typeof STABLE_PROPERTY_KEYS[number]))
    .map(([, value]) => typeof value === "string" || typeof value === "number" ? String(value) : "");
  const values = [scene.id, ...explicit];
  if (scene.path) values.push(...scene.path.split(/[\\/]/).slice(-2));
  return { values: [...new Set(values.map(normalizeIdentifier).filter(Boolean))], hasExplicit: explicit.length > 0 };
}

function resolveOneToOne(pairs: readonly ScoredPair[]): ScoredPair[] {
  const assignedScenes = new Set<string>();
  const assignedDevices = new Set<string>();
  const result: ScoredPair[] = [];
  for (const pair of pairs) {
    if (assignedScenes.has(pair.sceneObjectId) || assignedDevices.has(pair.deviceId)) continue;
    assignedScenes.add(pair.sceneObjectId);
    assignedDevices.add(pair.deviceId);
    result.push(pair);
  }
  return result;
}

function detectConflicts(
  rankedByScene: ReadonlyMap<string, readonly ScoredPair[]>,
  assignments: readonly ScoredPair[],
  minimumConfidence: number,
  ambiguityDelta: number,
): SmartBindingConflict[] {
  const assignedByDevice = new Map(assignments.map((pair) => [pair.deviceId, pair.sceneObjectId]));
  const topPairs = [...rankedByScene.values()].flatMap((pairs) => pairs[0] && pairs[0].confidence >= minimumConfidence ? [pairs[0]] : []);
  const topByDevice = new Map<string, ScoredPair[]>();
  for (const pair of topPairs) topByDevice.set(pair.deviceId, [...(topByDevice.get(pair.deviceId) ?? []), pair]);
  const conflicts: SmartBindingConflict[] = [];
  for (const [deviceId, contenders] of topByDevice) {
    if (contenders.length < 2) continue;
    const resolvedSceneObjectId = assignedByDevice.get(deviceId);
    conflicts.push({
      type: "device-contended",
      sceneObjectIds: contenders.map((pair) => pair.sceneObjectId).sort(compareText),
      deviceIds: [deviceId],
      ...(resolvedSceneObjectId ? { resolvedSceneObjectId, resolvedDeviceId: deviceId } : {}),
      explanation: "多个场景对象竞争同一设备；按置信度、对象 ID、设备 ID 稳定解析。",
    });
  }
  for (const [sceneObjectId, pairs] of rankedByScene) {
    const [first, second] = pairs;
    if (!first || !second || first.confidence < minimumConfidence || first.confidence - second.confidence >= ambiguityDelta) continue;
    const resolvedDeviceId = assignments.find((pair) => pair.sceneObjectId === sceneObjectId)?.deviceId;
    conflicts.push({
      type: "scene-ambiguous",
      sceneObjectIds: [sceneObjectId],
      deviceIds: [first.deviceId, second.deviceId].sort(compareText),
      resolvedSceneObjectId: sceneObjectId,
      ...(resolvedDeviceId ? { resolvedDeviceId } : {}),
      explanation: `前两名置信度差小于 ${format(ambiguityDelta)}，必须人工复核。`,
    });
  }
  return conflicts.sort((left, right) => left.type.localeCompare(right.type)
    || left.sceneObjectIds.join("/").localeCompare(right.sceneObjectIds.join("/"))
    || left.deviceIds.join("/").localeCompare(right.deviceIds.join("/")));
}

function factor(
  name: SmartBindingFactorName,
  score: number,
  available: boolean,
  explanation: string,
): SmartBindingEvidenceFactor {
  const weight = FACTOR_WEIGHTS[name];
  return { factor: name, score: round01(score), weight, contribution: available ? round01(score * weight) : 0, available, explanation };
}

function comparableTextFactor(name: "space" | "category", left: string | undefined, right: string | undefined): SmartBindingEvidenceFactor {
  const available = Boolean(normalizeText(left ?? "") && normalizeText(right ?? ""));
  const score = available ? textSimilarity(left!, right!) : 0;
  return factor(name, score, available, available ? `${name === "space" ? "空间" : "类别"}相似度 ${format(score)}` : `缺少双方${name === "space" ? "空间" : "类别"}`);
}

function sceneSpaceValue(scene: SmartBindingSceneObject): string | undefined {
  return propertyText(scene.properties, ["space", "room", "area", "zone", "floor"])
    ?? scene.path?.split(/[\\/]/).slice(0, -1).at(-1);
}

function propertyText(properties: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): string | undefined {
  if (!properties) return undefined;
  const wanted = new Set(keys.map(normalizeKey));
  const value = Object.entries(properties).find(([key, candidate]) => wanted.has(normalizeKey(key))
    && (typeof candidate === "string" || typeof candidate === "number"))?.[1];
  return value === undefined ? undefined : String(value);
}

function textSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  const leftTokens = new Set(normalizedLeft.split(" "));
  const rightTokens = new Set(normalizedRight.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenScore = intersection / Math.max(1, new Set([...leftTokens, ...rightTokens]).size);
  const compactScore = diceCoefficient(normalizedLeft.replaceAll(" ", ""), normalizedRight.replaceAll(" ", ""));
  return Math.max(tokenScore, compactScore);
}

function diceCoefficient(left: string, right: string): number {
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  if (leftPairs.length === 0 || rightPairs.length === 0) return left === right ? 1 : 0;
  const remaining = [...rightPairs];
  let matches = 0;
  for (const pair of leftPairs) {
    const index = remaining.indexOf(pair);
    if (index >= 0) { matches += 1; remaining.splice(index, 1); }
  }
  return 2 * matches / (leftPairs.length + rightPairs.length);
}

function bigrams(value: string): string[] {
  return Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2));
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function normalizeIdentifier(value: string): string {
  return normalizeText(value).replaceAll(" ", "");
}

function normalizeKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s-]+/g, "_");
}

function positionDistance(left: SmartBindingPosition | undefined, right: SmartBindingPosition | undefined): number | undefined {
  if (!left || !right || !finitePosition(left) || !finitePosition(right)) return undefined;
  const dz = (left.z ?? 0) - (right.z ?? 0);
  return Math.hypot(left.x - right.x, left.y - right.y, dz);
}

function finitePosition(value: SmartBindingPosition): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && (value.z === undefined || Number.isFinite(value.z));
}

function assertUniqueIds(sceneObjects: readonly SmartBindingSceneObject[], catalog: readonly SmartBindingCatalogItem[]): void {
  assertUnique(sceneObjects.map((item) => item.id), "场景对象 ID");
  assertUnique(catalog.map((item) => item.deviceId), "设备 ID");
  if (sceneObjects.some((item) => !item.id.trim() || !item.name.trim())) throw new Error("场景对象必须包含非空 id 和 name");
  if (catalog.some((item) => !item.deviceId.trim() || !item.name.trim())) throw new Error("设备目录必须包含非空 deviceId 和 name");
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} 必须唯一`);
}

function boundedOption(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) throw new Error(`${label} 必须在 0–1 范围内`);
  return resolved;
}

function positiveOption(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${label} 必须为有限正数`);
  return resolved;
}

function comparePairs(left: ScoredPair, right: ScoredPair): number {
  return right.confidence - left.confidence || compareText(left.sceneObjectId, right.sceneObjectId) || compareText(left.deviceId, right.deviceId);
}

function compareMappings(left: SmartBindingCandidate, right: SmartBindingCandidate): number {
  return compareText(left.sceneObjectId, right.sceneObjectId) || compareText(left.deviceId, right.deviceId);
}

function compareById(left: SmartBindingSceneObject, right: SmartBindingSceneObject): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function round01(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

function format(value: number): string {
  return Number(value.toFixed(4)).toString();
}
