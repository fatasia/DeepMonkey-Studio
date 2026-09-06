/** 只为编辑入口的目录和快照读取短暂重连；鉴权、AI、设备、数据查询及写操作保持既有语义。 */
export function isRecoverableStudioRead(pathname: string): boolean {
  return pathname === "/api/projects"
    || /^\/api\/projects\/[^/]+(?:\/(?:scenes|assets|applications))?$/.test(pathname)
    || /^\/api\/projects\/[^/]+\/applications\/[^/]+$/.test(pathname)
    || /^\/api\/projects\/[^/]+\/scenes\/[^/]+\/publications$/.test(pathname)
    || /^\/api\/scenes\/[^/]+\/browse$/.test(pathname);
}
