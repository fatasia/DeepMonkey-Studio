export const THREE_COMPAT_PROFILE_SCHEMA_VERSION = 1;

export type ThreeCompatibilityLevel = "full" | "project" | "facade" | "excluded";

export type ThreeProfileEvidenceSource =
  | "source"
  | "template"
  | "docs"
  | "ai-review"
  | "project-export"
  | "manual-review";

export interface ThreeProfileEvidence {
  readonly source: ThreeProfileEvidenceSource;
  readonly id: string;
  readonly usageCount?: number;
}

export interface ThreeClassCompatibility {
  readonly name: string;
  readonly level: ThreeCompatibilityLevel;
  readonly semantics: readonly string[];
  readonly evidence: readonly ThreeProfileEvidence[];
  readonly rawGraphOperations?: readonly string[];
}

export interface ThreeCompatibilityProfile {
  readonly schemaVersion: number;
  readonly threeVersion: string;
  readonly classes: readonly ThreeClassCompatibility[];
}

export interface ThreeProfileIssue {
  readonly code:
    | "invalid-structure"
    | "empty-profile"
    | "invalid-schema-version"
    | "invalid-three-version"
    | "invalid-class-name"
    | "invalid-level"
    | "duplicate-class"
    | "empty-semantics"
    | "duplicate-semantics"
    | "empty-evidence"
    | "duplicate-evidence"
    | "invalid-evidence-source"
    | "invalid-token"
    | "excluded-has-contract";
  readonly path: string;
  readonly message: string;
}

export interface ThreeProfileValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ThreeProfileIssue[];
}

const compatibilityLevels: readonly ThreeCompatibilityLevel[] = [
  "full",
  "project",
  "facade",
  "excluded",
];

const evidenceSources: readonly ThreeProfileEvidenceSource[] = [
  "source",
  "template",
  "docs",
  "ai-review",
  "project-export",
  "manual-review",
];

const protectedTokens = new Set(["__proto__", "prototype"]);

function issue(
  code: ThreeProfileIssue["code"],
  path: string,
  message: string,
): ThreeProfileIssue {
  return { code, path, message };
}

function validateTokens(
  values: unknown,
  path: string,
  issues: ThreeProfileIssue[],
): void {
  if (!Array.isArray(values)) {
    issues.push(issue("invalid-structure", path, "Expected a token array."));
    return;
  }
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const itemPath = `${path}[${index}]`;
    if (typeof value !== "string" || value.length === 0) {
      issues.push(issue("invalid-token", itemPath, "Token must be a non-empty string."));
      continue;
    }
    if (protectedTokens.has(value) || !/^[A-Za-z][A-Za-z0-9_.:]*$/.test(value)) {
      issues.push(
        issue(
          "invalid-token",
          itemPath,
          "Token must start with a letter and contain only letters, numbers, dot, colon, or underscore.",
        ),
      );
      continue;
    }
    if (seen.has(value)) {
      issues.push(issue("duplicate-semantics", itemPath, `Duplicate token: ${value}.`));
      continue;
    }
    seen.add(value);
  }
}

export function validateThreeCompatibilityProfile(
  input: unknown,
): ThreeProfileValidationResult {
  const issues: ThreeProfileIssue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, issues: [issue("invalid-structure", "profile", "Expected a profile object.")] };
  }
  // JSON 入口先检查结构，后续逐字段校验；有效不等于兼容性已实现。
  const profile = input as ThreeCompatibilityProfile;
  if (!Array.isArray(profile.classes)) {
    return { valid: false, issues: [issue("invalid-structure", "classes", "Expected a class array.")] };
  }
  if (profile.classes.length === 0) issues.push(issue("empty-profile", "classes", "Profile cannot be empty."));

  if (
    typeof profile.schemaVersion !== "number" ||
    !Number.isInteger(profile.schemaVersion) ||
    profile.schemaVersion !== THREE_COMPAT_PROFILE_SCHEMA_VERSION
  ) {
    issues.push(
      issue(
        "invalid-schema-version",
        "schemaVersion",
        `Expected schema version ${THREE_COMPAT_PROFILE_SCHEMA_VERSION}.`,
      ),
    );
  }

  if (typeof profile.threeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(profile.threeVersion)) {
    issues.push(
      issue("invalid-three-version", "threeVersion", "Expected a semantic version such as 0.185.1."),
    );
  }

  const classNames = new Set<string>();
  for (const [classIndex, classContract] of profile.classes.entries()) {
    const classPath = `classes[${classIndex}]`;
    if (!classContract || typeof classContract !== "object" || Array.isArray(classContract)) {
      issues.push(issue("invalid-structure", classPath, "Expected a class contract object."));
      continue;
    }
    if (
      typeof classContract?.name !== "string" ||
      !/^[A-Z][A-Za-z0-9_]*$/.test(classContract.name)
    ) {
      issues.push(
        issue("invalid-class-name", `${classPath}.name`, "Class name must be PascalCase."),
      );
    } else if (classNames.has(classContract.name)) {
      issues.push(
        issue("duplicate-class", `${classPath}.name`, `Duplicate class: ${classContract.name}.`),
      );
    } else {
      classNames.add(classContract.name);
    }

    if (!compatibilityLevels.includes(classContract.level)) {
      issues.push(
        issue("invalid-level", `${classPath}.level`, `Unsupported level: ${String(classContract.level)}.`),
      );
    }

    const hasSemantics = Array.isArray(classContract.semantics) && classContract.semantics.length > 0;
    if (classContract.level === "excluded") {
      if (hasSemantics) {
        issues.push(
          issue("excluded-has-contract", `${classPath}.semantics`, "Excluded classes cannot declare semantics."),
        );
      }
      if (classContract.rawGraphOperations?.length) {
        issues.push(
          issue(
            "excluded-has-contract",
            `${classPath}.rawGraphOperations`,
            "Excluded classes cannot declare raw graph operations.",
          ),
        );
      }
    } else if (!hasSemantics) {
      issues.push(
        issue("empty-semantics", `${classPath}.semantics`, "Compatible classes need at least one semantic."),
      );
    }

    if (hasSemantics) {
      validateTokens(classContract.semantics, `${classPath}.semantics`, issues);
    }
    if (classContract.rawGraphOperations !== undefined) {
      validateTokens(
        classContract.rawGraphOperations,
        `${classPath}.rawGraphOperations`,
        issues,
      );
    }

    if (!Array.isArray(classContract.evidence) || classContract.evidence.length === 0) {
      issues.push(
        issue("empty-evidence", `${classPath}.evidence`, "Each class needs at least one evidence entry."),
      );
    } else {
      const evidenceIds = new Set<string>();
      for (const [evidenceIndex, evidence] of classContract.evidence.entries()) {
        const evidencePath = `${classPath}.evidence[${evidenceIndex}]`;
        if (!evidenceSources.includes(evidence?.source)) {
          issues.push(
            issue("invalid-evidence-source", `${evidencePath}.source`, "Unknown evidence source."),
          );
        }
        if (typeof evidence?.id !== "string" || evidence.id.length === 0) {
          issues.push(issue("invalid-token", `${evidencePath}.id`, "Evidence id must be non-empty."));
        } else if (evidenceIds.has(evidence.id)) {
          issues.push(
            issue("duplicate-evidence", `${evidencePath}.id`, `Duplicate evidence id: ${evidence.id}.`),
          );
        } else {
          evidenceIds.add(evidence.id);
        }
        if (
          evidence?.usageCount !== undefined &&
          (!Number.isFinite(evidence.usageCount) || evidence.usageCount < 0)
        ) {
          issues.push(
            issue("invalid-token", `${evidencePath}.usageCount`, "Usage count must be a non-negative number."),
          );
        }
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
