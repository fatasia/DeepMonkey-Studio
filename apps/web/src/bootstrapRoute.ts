/** Published applications own only the `/apps` route family; the desktop root must reach its connection gate first. */
export function isPublishedApplicationRoute(pathname: string): boolean {
  return /^\/apps(?:\/|$)/.test(pathname);
}
