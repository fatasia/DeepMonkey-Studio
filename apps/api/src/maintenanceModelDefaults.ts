import type { MaintenanceModelPackage } from "@bim-studio/contracts";

export const DEFAULT_MAINTENANCE_GATES: MaintenanceModelPackage["gates"] = {
  minimumSamples: 30,
  minimumDataQuality: 0.9,
  maximumDriftSigma: 5,
  warningThreshold: 0.45,
  criticalThreshold: 0.7,
  scoreDirection: "high-risk",
};
