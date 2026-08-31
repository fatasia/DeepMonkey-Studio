export interface ProviderToken {
  value: string;
  expiresInSeconds: number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** 多次告警共用企业 token，提前一分钟刷新，避免每条消息都请求鉴权接口。 */
export class NotificationTokenCache {
  private readonly entries = new Map<string, CachedToken>();

  async get(key: string, load: () => Promise<ProviderToken>): Promise<string> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > Date.now()) return current.value;
    const next = await load();
    this.entries.set(key, {
      value: next.value,
      expiresAt: Date.now() + Math.max(30, next.expiresInSeconds - 60) * 1_000,
    });
    return next.value;
  }
}
