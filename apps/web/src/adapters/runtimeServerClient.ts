import { ServerClient, type ServerClientOptions } from '@bim-studio/server-sdk';

/** Only a split-host browser needs managed URL expansion; default/desktop records retain their bytes. */
export function managedApiResourceUrls<T>(value: T, apiOrigin?: string, canonical = false): T {
  if (!apiOrigin || value === null || typeof value !== 'object') return value;
  const visit = (item: unknown, key = ''): unknown => {
    if (key === 'rows') return item; // Row values are user data; they are not resource metadata.
    if (typeof item === 'string' && /(?:url|uri|src|thumbnail|poster)$/i.test(key)) {
      let path = item;
      if (canonical && item.startsWith(`${apiOrigin}/`)) {
        const url = new URL(item); path = `${url.pathname}${url.search}${url.hash}`;
      }
      if (/^\/(?:assets|runtime)\//.test(path) || /^(?:assetUrl|contentUrl)$/i.test(key) && path.startsWith('/api/')) {
        return canonical ? path : new URL(path, apiOrigin).href;
      }
    }
    if (Array.isArray(item)) return item.map(child => visit(child));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, name)]));
    return item;
  };
  return visit(value) as T;
}

export class RuntimeServerClient extends ServerClient {
  constructor(options: ServerClientOptions, private readonly splitApiOrigin: () => string | undefined) { super(options); }
  override async request<T>(path: string, init?: RequestInit): Promise<T> {
    const origin = this.splitApiOrigin();
    // Persist portable managed paths rather than the currently selected API host.
    const input = origin && typeof init?.body === 'string' && new Headers(init.headers).get('content-type')?.includes('application/json')
      ? { ...init, body: JSON.stringify(managedApiResourceUrls(JSON.parse(init.body), origin, true)) } : init;
    return managedApiResourceUrls(await super.request<T>(path, input), origin);
  }
}
