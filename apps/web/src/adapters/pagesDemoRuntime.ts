/** Static demo opt-in is emitted only by the Pages packager. */
export function isPagesDemoRuntime(): boolean {
  return typeof document !== 'undefined' && Boolean(document.querySelector('meta[name="studio-pages-workspace"]'));
}

export function pagesDemoManifestUrl(): string {
  const value = document.querySelector<HTMLMetaElement>('meta[name="studio-pages-workspace"]')?.content;
  if (!value) throw new Error('缺少浏览器示例工作区清单');
  const url = new URL(value, window.location.href);
  if (url.origin !== window.location.origin) throw new Error('示例工作区清单须与网页同源');
  return url.href;
}
