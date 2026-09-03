/**
 * 复制文档代码。内网 HTTP 或旧 WebView 可能拒绝 Clipboard API，
 * 因此保留只在用户点击期间执行的原生复制兼容路径。
 */
export async function copyDocumentationCode(value: string): Promise<void> {
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(value);
      return;
    } catch {
      // 继续使用下方兼容路径。
    }
  }

  if (!globalThis.document?.body) throw new Error("当前环境不支持复制");
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("浏览器拒绝复制");
  } finally {
    textarea.remove();
  }
}
