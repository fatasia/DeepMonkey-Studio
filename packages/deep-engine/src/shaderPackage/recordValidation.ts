import { DEEP_SHADER_PACKAGE_BUDGETS } from "./constants.js";
import { hashCanonicalShaderPackage, sha256Utf8 } from "./hash.js";
import {
  exactFields, issue, PACKAGE_ID_PATTERN, record, RECORD_ID_PATTERN,
  requireArray, requireCanonicalOrder, validString, validateHash,
} from "./primitives.js";
import type {
  ShaderPackageDependency, ShaderPackageDiagnostic, ShaderPackageModule,
} from "./types.js";

export function validateDependencies(
  value: unknown,
  diagnostics: ShaderPackageDiagnostic[],
): { ids: Set<string>; values: ShaderPackageDependency[] } {
  const ids = new Set<string>();
  const values: ShaderPackageDependency[] = [];
  const order: string[] = [];
  const items = requireArray(
    value, DEEP_SHADER_PACKAGE_BUDGETS.maxDependencies, "$.dependencies", diagnostics,
  );
  items?.forEach((item, index) => {
    const initialIssues = diagnostics.length;
    const path = `$.dependencies.${index}`;
    if (!record(item)) {
      issue(diagnostics, "invalid-type", path, "Expected dependency record.");
      return;
    }
    exactFields(item, ["id", "contentHash"], path, diagnostics);
    if (validString(item.id, `${path}.id`, diagnostics, PACKAGE_ID_PATTERN)) {
      if (ids.has(item.id)) issue(diagnostics, "duplicate-id", `${path}.id`, "Duplicate dependency ID.");
      ids.add(item.id);
      order.push(item.id);
    }
    validateHash(item.contentHash, `${path}.contentHash`, diagnostics);
    if (diagnostics.length === initialIssues) {
      values.push(item as unknown as ShaderPackageDependency);
    }
  });
  requireCanonicalOrder(order, "$.dependencies", diagnostics);
  return { ids, values };
}

export function validateModules(
  value: unknown,
  dependencyIds: ReadonlySet<string>,
  diagnostics: ShaderPackageDiagnostic[],
): Map<string, ShaderPackageModule> {
  const modules = new Map<string, ShaderPackageModule>();
  const seenIds = new Set<string>();
  const order: string[] = [];
  const items = requireArray(
    value, DEEP_SHADER_PACKAGE_BUDGETS.maxModules, "$.modules", diagnostics,
  );
  if (items?.length === 0) {
    issue(diagnostics, "invalid-value", "$.modules", "At least one WGSL module is required.");
  }
  let totalBytes = 0;
  items?.forEach((item, index) => {
    const initialIssues = diagnostics.length;
    const path = `$.modules.${index}`;
    if (!record(item)) {
      issue(diagnostics, "invalid-type", path, "Expected module record.");
      return;
    }
    exactFields(
      item, ["id", "language", "source", "sourceHash", "dependencyIds"], path, diagnostics,
    );
    if (validString(item.id, `${path}.id`, diagnostics, RECORD_ID_PATTERN)) {
      if (seenIds.has(item.id)) issue(diagnostics, "duplicate-id", `${path}.id`, "Duplicate module ID.");
      seenIds.add(item.id);
      order.push(item.id);
    }
    if (item.language !== "wgsl") issue(diagnostics, "invalid-value", `${path}.language`, "WGSL is required.");
    if (typeof item.source !== "string") {
      issue(diagnostics, "invalid-type", `${path}.source`, "Expected WGSL string.");
    } else {
      const bytes = new TextEncoder().encode(item.source).byteLength;
      totalBytes += bytes;
      if (bytes > DEEP_SHADER_PACKAGE_BUDGETS.maxWgslBytesPerModule) {
        issue(diagnostics, "budget-exceeded", `${path}.source`, "WGSL byte budget exceeded.");
      }
      if (record(item.sourceHash) && item.sourceHash.value !== sha256Utf8(item.source)) {
        issue(diagnostics, "hash-mismatch", `${path}.sourceHash.value`, "WGSL source hash mismatch.");
      }
    }
    validateHash(item.sourceHash, `${path}.sourceHash`, diagnostics);
    const references = requireArray(
      item.dependencyIds, DEEP_SHADER_PACKAGE_BUDGETS.maxDependencies,
      `${path}.dependencyIds`, diagnostics,
    );
    const referenceOrder: string[] = [];
    references?.forEach((id, dependencyIndex) => {
      if (!validString(id, `${path}.dependencyIds.${dependencyIndex}`, diagnostics, PACKAGE_ID_PATTERN)) return;
      referenceOrder.push(id);
      if (!dependencyIds.has(id)) {
        issue(diagnostics, "missing-reference", `${path}.dependencyIds.${dependencyIndex}`, `Unknown dependency ${id}.`);
      }
    });
    requireCanonicalOrder(referenceOrder, `${path}.dependencyIds`, diagnostics);
    if (typeof item.id === "string" && record(item.sourceHash)
      && typeof item.sourceHash.value === "string") {
      const expected = `module.${hashCanonicalShaderPackage({
        sourceHash: item.sourceHash.value, dependencyIds: referenceOrder,
      })}`;
      if (item.id !== expected) {
        issue(diagnostics, "hash-mismatch", `${path}.id`, "Content-addressed module ID mismatch.");
      }
    }
    if (diagnostics.length === initialIssues) {
      modules.set(item.id as string, item as unknown as ShaderPackageModule);
    }
  });
  if (totalBytes > DEEP_SHADER_PACKAGE_BUDGETS.maxTotalWgslBytes) {
    issue(diagnostics, "budget-exceeded", "$.modules", "Total WGSL budget exceeded.");
  }
  requireCanonicalOrder(order, "$.modules", diagnostics);
  return modules;
}
