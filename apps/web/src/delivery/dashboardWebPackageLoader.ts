import { assertDashboardWebPackage, DASHBOARD_WEB_FILE_LIMIT, type DashboardWebPackage } from "./dashboardWebPackage";
import { dashboardFrozenFontStyle } from "./dashboardFrozenFontStyle";

async function readBytes(url: URL, limit: number, signal: AbortSignal, fetcher: typeof fetch): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const response = await fetcher(url,{signal,credentials:"omit",cache:"no-store",redirect:"error"});
  if (!response.ok || !response.body) throw new Error(`静态包文件读取失败（HTTP ${response.status}），请重新部署完整目录`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const {done,value} = await reader.read();
      // EOF 与取消同时到达时必须以取消为准，禁止在已取消后仍返回"完整包"。
      if (done) { signal.throwIfAborted(); break; }
      size += value.length;
      if (size > limit) throw new Error("静态包文件超过预算");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) {result.set(chunk,offset);offset += chunk.length;}
  return result;
}
export async function loadDashboardWebPackage(base: URL, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  if (!["http:","https:"].includes(base.protocol)) throw new Error("请通过静态 HTTP 服务打开此目录，不支持 file://");
  if (!base.href.endsWith("/")) throw new Error("静态包根地址必须以 / 结尾");
  const resolvePackagedUrl = (path: string): URL => {
    const url = new URL(path,base);
    // manifest 校验已拒绝穿越路径；此处按解析结果再挡一次，保证任何请求都落在包根内。
    if (url.origin !== base.origin || !url.href.startsWith(base.href)) throw new Error(`静态包文件路径越界：${path}`);
    return url;
  };
  const bytes = await readBytes(resolvePackagedUrl("dashboard.web.json"),8*1024*1024,signal,fetcher);
  const manifest: unknown = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  assertDashboardWebPackage(manifest);
  const resources = new Map<string,Uint8Array>();
  for (const file of [...manifest.runtimeFiles,...manifest.resources]) {
    const data = await readBytes(resolvePackagedUrl(file.path),Math.min(file.bytes,DASHBOARD_WEB_FILE_LIMIT),signal,fetcher);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256",data))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
    if (data.length !== file.bytes || hash !== file.sha256) throw new Error(`静态包文件校验失败：${file.path}，请重新部署完整目录`);
    if (manifest.resources.some(item=>item.path===file.path)) resources.set(file.path,data);
  }
  return {manifest,resources};
}
export async function mountDashboardWebResources(manifest: DashboardWebPackage, resources: ReadonlyMap<string,Uint8Array>) {
  const urls: string[] = [], faces: FontFace[] = [], replacements = new Map<string,string>();
  const dispose = () => { urls.forEach(url=>URL.revokeObjectURL(url)); faces.forEach(face=>document.fonts.delete(face)); };
  try {
    for (const resource of manifest.resources) {
      const bytes = resources.get(resource.path); if (!bytes) throw new Error("静态包资源未完成校验");
      if (resource.font) {
        const style = dashboardFrozenFontStyle(bytes);
        if (style.weight !== resource.font.weight || style.style !== resource.font.style) throw new Error("静态包字体与声明不一致");
        const face = new FontFace("DashboardPackage",Uint8Array.from(bytes).buffer,{weight:String(style.weight),style:style.style});
        await face.load(); document.fonts.add(face); faces.push(face);
      } else {
        const url=URL.createObjectURL(new Blob([Uint8Array.from(bytes)],{type:resource.mime}));
        urls.push(url); replacements.set(resource.sourceUrl,url);
      }
    }
    const rewrite = (item: unknown): unknown => typeof item === "string" ? replacements.get(item) ?? item
      : Array.isArray(item) ? item.map(rewrite) : item && typeof item === "object"
        ? Object.fromEntries(Object.entries(item).map(([key,value])=>[key,rewrite(value)])) : item;
    return {application:rewrite(manifest.publication.document) as DashboardWebPackage["publication"]["document"],dispose};
  } catch(error) {dispose();throw error;}
}
