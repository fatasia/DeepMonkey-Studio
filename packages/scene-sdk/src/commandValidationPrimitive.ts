import type { PrimitiveKind } from "@bim-studio/contracts";
import type { SceneCommand, SceneObjectRef } from "./protocol.js";
import type { InspectedRecord, ValidationContext } from "./commandValidationTypes.js";
import { addIssue } from "./commandValidationSafety.js";
import { isOneOf, parseMaterialColor, parseRequiredIdentifier, readRequired, rejectUnknownProperties } from "./commandValidationFields.js";

const PRIMITIVE_KINDS = ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"] as const satisfies readonly PrimitiveKind[];

export function parsePrimitiveCommand(
  id: string,
  record: InspectedRecord,
  target: SceneObjectRef | undefined,
  context: ValidationContext,
): Extract<SceneCommand, { type: "object.create-primitive" }> | undefined {
  rejectUnknownProperties(record, ["id", "type", "target", "name", "kind", "color"], "$", context);
  if (target && target.kind !== "object") addIssue(context, "$.target", "invalid-value", "Primitive creation requires an object target.");
  const name = parseRequiredIdentifier(record, "name", "$", context);
  const kindValue = readRequired(record, "kind", "$", context);
  const kind = typeof kindValue === "string" && isOneOf(kindValue, PRIMITIVE_KINDS) ? kindValue : undefined;
  if (kindValue !== undefined && kind === undefined) addIssue(context, "$.kind", "invalid-value", `Expected one of: ${PRIMITIVE_KINDS.join(", ")}.`);
  const color = parseMaterialColor(readRequired(record, "color", "$", context), "$.color", context);
  return target?.kind === "object" && name && kind && color ? { id, type: "object.create-primitive", target, name, kind, color } : undefined;
}
