/** T20 粒子切片:CPU 统计参考、预算/降级、事件、曲线与烟体卫生基线。 */

export {
  createConstantParticleCurve, createParticleCurve, evaluateParticleCurve,
  evaluateParticleCurveOverLife, meanParticleCurveValue,
} from "./particleCurves.js";
export type { ParticleCurve, ParticleCurveEvaluation, ParticleCurveKeyframe } from "./particleCurves.js";

export { enforceParticleCapacity, particleBudgetLadder, planParticleBudget } from "./particleBudget.js";
export type { EnforceCapacityInput, EnforceCapacityOutcome, ParticleBudgetAllocation,
  ParticleBudgetDegradation, ParticleBudgetOptions, ParticleBudgetPlan,
  ParticleBudgetRequest } from "./particleBudget.js";

export { createReferenceEmitterSeeds, particleIdHash, particleNoise, simulateEmitterStatistics,
  simulateParticleSystemStatistics, stepReferenceParticle } from "./particleStats.js";
export type { DistributionSummary, ParticleSimulationStatistics, ParticleSystemSimulationResult,
  ReferenceEmitterConfig, ReferenceEmitterPreset, ReferenceFrameInput, ReferenceParticle,
  ReferenceVec3 } from "./particleStats.js";

export { simulateParticleEvents } from "./particleEvents.js";
export type { ParticleCollisionPlane, ParticleEvent, ParticleEventKind, ParticleEventOptions,
  ParticleEventResult, ParticleEventStats } from "./particleEvents.js";

export { simulateSmokeDiffusion, smokeAnalyticField, smokeDiffusionConvergence } from "./smokeDiffusion.js";
export type { SmokeBoundary, SmokeConvergenceRow, SmokeDiffusionOptions,
  SmokeDiffusionResult } from "./smokeDiffusion.js";
