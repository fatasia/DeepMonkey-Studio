import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationLocationPath, applicationPath, browserApiOrigin } from './browserRuntimeConfig';
import { RuntimeServerClient, managedApiResourceUrls } from './runtimeServerClient';
import { sceneDataWebSocketUrl } from './sceneDataSocket';
import { BrowserHostAdapter } from './browserHostAdapter';
import { readRoute, routePath } from '../appRoute';
import { isPublishedApplicationRoute } from '../bootstrapRoute';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('split-host editor', () => {
  it('retains default origin and rejects credential, subpath, and mixed-content profiles', () => {
    expect(browserApiOrigin('https://page.test', '')).toBe('https://page.test');
    expect(browserApiOrigin('https://page.test', 'https://api.test/')).toBe('https://api.test');
    for (const url of ['https://u:p@api.test', 'https://api.test/base', 'https://api.test?token=x', 'http://api.test', 'file:///api']) {
      expect(() => browserApiOrigin('https://page.test', url)).toThrow();
    }
  });
  it('round-trips all workspace routes below the Pages base', () => {
    vi.stubEnv('BASE_URL', '/DeepMonkey-Studio/');
    const location = { pathname: '/DeepMonkey-Studio/', search: '', origin: 'https://page.test' };
    vi.stubGlobal('window', { location, history: { state: null } });
    const routes = [
      { view: 'manager', projectId: 'p 1', managerTab: 'assets' }, { view: 'data', projectId: 'p 1' },
      { view: 'studio', projectId: 'p 1', applicationId: 'a1', sceneId: 's1' },
      { view: 'dashboard', projectId: 'p1', applicationId: 'a1', pageId: 'd1' },
      { view: 'docs', documentId: 'studio-api' }, { view: 'published', sceneId: 's1' },
    ] as const;
    for (const route of routes) {
      const url = new URL(routePath(route), location.origin);
      expect(url.pathname).toMatch(/^\/DeepMonkey-Studio\//);
      location.pathname = url.pathname; location.search = url.search;
      expect(readRoute()).toMatchObject(route);
    }
    expect(applicationLocationPath('/DeepMonkey-Studio/')).toBe('/');
    expect(applicationLocationPath('/DeepMonkey-Studio')).toBe('/');
    expect(applicationLocationPath('/DeepMonkey-Studio-old/data')).not.toBe('/data');
    expect(isPublishedApplicationRoute('/DeepMonkey-Studio/apps/a1')).toBe(true);
    expect(isPublishedApplicationRoute('/apps/a1')).toBe(false);
    expect(applicationPath('/manager?project=p')).toBe('/DeepMonkey-Studio/manager?project=p');
  });
  it('keeps API auth in its own realm and attaches it to a real ServerClient request', async () => {
    const map = new Map<string, string>([['bim-studio-auth-token', 'old-local']]);
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) };
    const host = new BrowserHostAdapter({ location: { origin: 'https://page.test' }, localStorage: store, sessionStorage: store } as unknown as Window, 'https://api.test');
    expect(host.getAccessToken()).toBe(''); host.setAccessToken('api-session', true);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: { manifest: { geometryUrl: '/assets/projects/p/model.glb' } } }), { status: 200 }));
    const client = new RuntimeServerClient({ profile: () => host.getServerProfile(), authStore: host, fetch: fetcher }, () => 'https://api.test');
    const result = await client.request<{ model: { manifest: { geometryUrl: string } } }>('/api/projects/p');
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://api.test/api/projects/p');
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer api-session');
    expect(result.model.manifest.geometryUrl).toBe('https://api.test/assets/projects/p/model.glb');
    await client.request('/api/projects/p/scenes/s', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ environmentMapUrl: 'https://api.test/assets/projects/p/light.hdr' }) });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ environmentMapUrl: '/assets/projects/p/light.hdr' });
    expect(map.get('bim-studio-auth-token')).toBe('old-local'); host.clearAccessToken();
    expect(map.get('bim-studio-auth-token')).toBe('old-local');
    expect(sceneDataWebSocketUrl(host.getServerProfile().baseUrl, 'p')).toBe('wss://api.test/api/projects/p/data/ws');
  });
  it('accepts the editable runtime meta origin before the build-time default', () => {
    vi.stubEnv('VITE_STUDIO_API_ORIGIN', 'https://build-api.test');
    vi.stubGlobal('document', { querySelector: () => ({ content: 'https://runtime-api.test' }) });
    expect(browserApiOrigin('https://page.test')).toBe('https://runtime-api.test');
  });
  it('rewrites managed media while preserving data strings, external assets, and strict dependency API paths', () => {
    const data = { rows: [{ value: '/assets/user-value', sourceUrl: '/assets/data-cell' }], sourceUrl: 'https://external.test/a.glb',
      dependencies: [{ url: '/api/projects/p/scenes/s/publications/1/dependencies/resources/abc' }],
      script: { assetUrl: '/api/projects/p/script-dependencies/a/content' }, imageUrl: '/assets/library/a.png' };
    expect(managedApiResourceUrls(data)).toBe(data);
    const normalized = managedApiResourceUrls(data, 'https://api.test');
    expect(normalized.rows).toEqual(data.rows); expect(normalized.sourceUrl).toBe(data.sourceUrl);
    expect(normalized.dependencies).toEqual(data.dependencies);
    expect(normalized.script.assetUrl).toBe('https://api.test/api/projects/p/script-dependencies/a/content');
    expect(normalized.imageUrl).toBe('https://api.test/assets/library/a.png');
  });
});
