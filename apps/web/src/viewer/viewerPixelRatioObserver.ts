/** 分辨率媒体查询在跨屏后需要重新绑定，即使容器 CSS 尺寸完全没变。 */
export function observeViewerPixelRatio(onChange: () => void): () => void {
  let disposed = false;
  let query: MediaQueryList | undefined;
  const changed = () => {
    if (disposed) return;
    bind();
    onChange();
  };
  const bind = () => {
    query?.removeEventListener("change", changed);
    query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    query?.addEventListener("change", changed);
  };
  bind();
  window.addEventListener("resize", changed);
  return () => {
    disposed = true;
    query?.removeEventListener("change", changed);
    window.removeEventListener("resize", changed);
  };
}
