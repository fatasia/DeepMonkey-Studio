import { NotificationTransportError } from "./notificationTransportError.js";

export interface NotificationHttpClient {
  request(url: string, init: RequestInit): Promise<{ status: number; body: unknown }>;
}

export const fetchNotificationHttpClient: NotificationHttpClient = {
  async request(url, init) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
      const text = await response.text();
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : {}; } catch { /* 保留非 JSON 错误正文 */ }
      return { status: response.status, body };
    } catch (error) {
      throw new NotificationTransportError("network_or_timeout", true, error instanceof Error ? error.message : String(error));
    }
  },
};

export async function requestJson(client: NotificationHttpClient, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await client.request(url, init);
  if (response.status < 200 || response.status >= 300) {
    throw new NotificationTransportError(`http_${response.status}`, response.status === 429 || response.status >= 500);
  }
  if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
    throw new NotificationTransportError("provider_invalid_response", false);
  }
  return response.body as Record<string, unknown>;
}

export function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}
