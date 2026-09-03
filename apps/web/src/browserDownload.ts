/** Browser-only file delivery shared by scene packages and lightweight reports. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function downloadTextFile(content: string, fileName: string, mimeType: string): void {
  downloadBlob(new Blob([content], { type: mimeType }), fileName);
}

/** Print a self-contained HTML document without navigating away from the workbench. */
export function printHtmlDocument(html: string, title: string): void {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.style.opacity = "0";
  document.body.append(frame);

  const target = frame.contentDocument;
  const printable = frame.contentWindow;
  if (!target || !printable) {
    frame.remove();
    throw new Error("当前浏览器无法创建打印文档");
  }
  target.open();
  target.write(html);
  target.close();

  const print = () => {
    printable.addEventListener("afterprint", () => frame.remove(), { once: true });
    printable.focus();
    printable.print();
    window.setTimeout(() => frame.remove(), 60_000);
  };
  if (target.readyState === "complete") window.setTimeout(print, 0);
  else frame.addEventListener("load", print, { once: true });
}
