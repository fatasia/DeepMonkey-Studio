/** 同源窗口间互斥；operation 的 promise 结束后由浏览器释放锁，不排队或抢占。 */
export async function withSceneArtifactLock<T>(
  ownerId: string,
  projectId: string,
  sceneId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (![ownerId, projectId, sceneId].every((value) => typeof value === "string" && value.trim())) {
    throw new Error("打包任务缺少用户或场景身份。");
  }
  if (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function") {
    throw new Error("当前浏览器不支持打包任务互斥，请使用支持 Web Locks 的浏览器并通过 HTTPS 或 localhost 打开。");
  }
  const name = `scene-artifact-lock:${JSON.stringify([ownerId, projectId, sceneId])}`;
  return navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("该场景已有打包任务正在执行，请在完成后重新读取或重试。");
    return operation();
  });
}
