import type {
  DirectBindingSpec,
  DirectBindingTemplateValue,
} from "@bim-studio/contracts";

export type DirectBindingVariables = Record<string, DirectBindingTemplateValue>;

export interface ResolvedDirectCredential {
  /** Injected only by the server; persisted binding documents never contain secret values. */
  headers: Record<string, string>;
}

export interface DirectCredentialResolver {
  resolve(credentialRef: string): Promise<ResolvedDirectCredential | undefined>;
}

export interface DirectBindingOutboundPolicy {
  allowedPorts?: readonly number[];
  allowPrivateNetwork?: boolean;
  allowedHostnames?: readonly string[];
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface DirectBindingGatewayOptions {
  credentialResolver?: DirectCredentialResolver;
  outboundPolicy?: DirectBindingOutboundPolicy;
  /** Same-process origin used only when a persisted binding starts with `/`. */
  internalOrigin?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolveHost?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export interface DirectHttpGatewayResponse {
  ok: true;
  status: number;
  contentType?: string;
  data: unknown;
  value: unknown;
}

export type DirectBindingErrorCode =
  | "INVALID_BINDING"
  | "OUTBOUND_DENIED"
  | "CREDENTIAL_NOT_FOUND"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_TOO_LARGE"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_ERROR";

export class DirectBindingGatewayError extends Error {
  constructor(
    readonly code: DirectBindingErrorCode,
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DirectBindingGatewayError";
  }
}

export function renderTemplate(
  value: DirectBindingTemplateValue,
  variables: DirectBindingVariables,
): DirectBindingTemplateValue {
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplate(item, variables)]),
    );
  }
  if (typeof value !== "string") return value;
  const exact = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(value);
  if (exact) return variables[exact[1]!] ?? value;
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, name: string) =>
    String(variables[name] ?? ""),
  );
}

export function selectDirectBindingValue(
  data: unknown,
  binding: Pick<DirectBindingSpec, "selection">,
): unknown {
  let selected = data;
  if (binding.selection?.jsonPath)
    selected = evaluateJsonPath(selected, binding.selection.jsonPath);
  if (binding.selection?.field) {
    if (!selected || typeof selected !== "object") return undefined;
    selected = (selected as Record<string, unknown>)[binding.selection.field];
  }
  return selected;
}

function evaluateJsonPath(value: unknown, path: string): unknown {
  if (path === "$") return value;
  if (!path.startsWith("$"))
    throw new DirectBindingGatewayError(
      "INVALID_BINDING",
      "jsonPath 必须以 $ 开头",
      400,
      false,
    );
  const tokens = path
    .slice(1)
    .match(/\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\["([^"\\]+)"\]|\['([^'\\]+)'\]/g);
  if (!tokens || tokens.join("") !== path.slice(1)) {
    throw new DirectBindingGatewayError(
      "INVALID_BINDING",
      "jsonPath 仅支持属性和数组下标",
      400,
      false,
    );
  }
  let current = value;
  for (const token of tokens) {
    const match =
      /^\.([A-Za-z_$][\w$-]*)$|^\[(\d+)\]$|^\["([^"\\]+)"\]$|^\['([^'\\]+)'\]$/.exec(
        token,
      )!;
    const key = match[1] ?? match[2] ?? match[3] ?? match[4]!;
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
