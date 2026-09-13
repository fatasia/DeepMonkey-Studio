import type { ResourcePreviewDefinition } from "./resourcePreviewRuntime";

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | undefined>>();
let tail = Promise.resolve();

/** 只为进入可视区域的资源串行渲染，复用正式预览加载器，不给每张卡片常驻一个 WebGL 上下文。 */
export function projectResourceThumbnail(definition: ResourcePreviewDefinition, key: string): Promise<string | undefined> {
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (pending.has(key)) return pending.get(key)!;
  const result = tail.then(() => render(definition)).catch(() => undefined).then(url => {
    pending.delete(key);
    if (url) {
      cache.set(key, url);
      if (cache.size > 80) cache.delete(cache.keys().next().value!);
    }
    return url;
  });
  pending.set(key, result);
  tail = result.then(() => undefined);
  return result;
}

async function render(definition: ResourcePreviewDefinition): Promise<string | undefined> {
  const { createResourcePreview } = await import("./resourcePreviewRuntime");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:360px;height:270px;pointer-events:none";
  document.body.append(host);
  let dispose: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      timer = setTimeout(() => resolve(undefined), 25_000);
      dispose = createResourcePreview(host, definition, error => { if (error) reject(new Error(error)); }, capture => {
        if (!capture) return;
        void capture().then(blob => new Promise<string>((done, fail) => {
          const reader = new FileReader(); reader.onload = () => done(String(reader.result)); reader.onerror = () => fail(reader.error); reader.readAsDataURL(blob);
        })).then(resolve, reject);
      });
    });
  } finally { clearTimeout(timer); dispose?.(); host.remove(); }
}
