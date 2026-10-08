/** Hosting coordinates contain no credentials. The browser API remains same-origin by default. */
export function browserApiOrigin(pageOrigin: string, configured = readConfiguredApiOrigin()): string {
  if (!configured.trim()) return pageOrigin;
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('工作台 API 地址须为不含路径或凭据的 HTTP(S) origin');
  if (pageOrigin.startsWith('https:') && url.protocol !== 'https:') throw new Error('HTTPS 工作台须使用 HTTPS API');
  return url.origin;
}

function readConfiguredApiOrigin(): string {
  return (typeof document === 'undefined' ? undefined : document.querySelector<HTMLMetaElement>('meta[name="studio-api-origin"]')?.content)
    ?? import.meta.env.VITE_STUDIO_API_ORIGIN ?? '';
}

export function applicationBase(): string {
  const base = import.meta.env.BASE_URL ?? '/';
  if (!base.startsWith('/') || base.startsWith('//') || /[?#\\]/.test(base)) throw new Error('工作台 base 须为网站绝对子路径');
  return base.endsWith('/') ? base : `${base}/`;
}

export function applicationPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('工作台路径须从根路径开始');
  return `${applicationBase().slice(0, -1)}${path}`;
}

export function applicationLocationPath(pathname: string): string {
  const base = applicationBase();
  if (base === '/') return pathname;
  if (pathname === base.slice(0, -1)) return '/';
  return pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : '/__outside_workbench_base__';
}
