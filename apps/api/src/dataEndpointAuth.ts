import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { MetadataStore } from "./store.js";

const PREFIX = "bsp_";

export function createDataApiKey(): string {
  return `${PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function hashDataApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function dataApiKeyHint(apiKey: string): string {
  return `••••${apiKey.slice(-6)}`;
}

export function authenticateDataEndpoint(request: FastifyRequest, store: MetadataStore, endpointId: string): boolean {
  const provided = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? websocketProtocolKey(request.headers["sec-websocket-protocol"]);
  const expected = store.getDataEndpointSecretHash(endpointId);
  if (!provided || !expected) return false;
  const actual = hashDataApiKey(provided);
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function websocketProtocolKey(header: string | string[] | undefined): string | undefined {
  const values = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((value) => value.trim());
  const protocol = values.find((value) => value.startsWith("bim-studio-key."));
  return protocol?.slice("bim-studio-key.".length);
}
