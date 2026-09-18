/** 公开对象入口不接受文件系统别名，也不公开按发布版本授权的冻结字节。 */
export function isPublicAssetKey(key: string): boolean {
  const segments = key.split("/");
  if (!segments.every(segment => segment && segment !== "." && segment !== ".."
    && !/[. ]$/.test(segment) && !/[<>:"\\|?*%\u0000-\u001f\u007f]/.test(segment)
    && !/~\d/.test(segment)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) return false;
  return !/^projects\/[^/]+\/publication-resources(?:\/|$)/i.test(key);
}
