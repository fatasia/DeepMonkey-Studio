import { ServerRequestError } from "@bim-studio/server-sdk";

/** A retained historical file is not a failed removal from the current draft. */
export function isRetainedScriptDependency(reason: unknown): boolean {
  return reason instanceof ServerRequestError && reason.status === 409
    && typeof reason.body === "object" && reason.body !== null
    && "code" in reason.body && reason.body.code === "dependency-in-use";
}
