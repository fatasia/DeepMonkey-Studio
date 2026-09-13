export class DeepSceneStateError extends Error {
  constructor(
    readonly code: "invalid-id" | "missing-object" | "invalid-parent" | "invalid-index" | "invalid-material",
    message: string,
  ) {
    super(message);
    this.name = "DeepSceneStateError";
  }
}

export function assertValidSceneId(id: string): void {
  if (
    typeof id !== "string" || id.length === 0 ||
    id === "__proto__" || id === "constructor" || id === "prototype" ||
    !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(id)
  ) {
    throw new DeepSceneStateError("invalid-id", `Invalid scene object id: ${String(id)}.`);
  }
}
