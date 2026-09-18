import { randomUUID } from "node:crypto";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { CapturedScenePublicationDependencies } from "./metadataStore.js";
import { scenePublicationJsonEqual } from "./scenePublicationStore.js";
import { assertCapturedSceneDependencies } from "./scenePublicationDependencyStore.js";

export interface NativeScenePublicationCandidate {
  actorId: string;
  scene: SceneSnapshot;
  expectedPublication?: PublishedSceneRecord;
  capture: CapturedScenePublicationDependencies;
}
interface Entry { value: NativeScenePublicationCandidate; expiresAt: number; bytes: number; lease?: string }

/** 服务进程持有的短期凭据；重启失效，共享内容地址文件不随租约删除。 */
export function createNativeSceneCandidateRegistry(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const ttl = 10 * 60_000, maximumBytes = 32 * 1024 ** 2;
  const sweep = () => {
    for (const [id, entry] of entries) if (!entry.lease && entry.expiresAt <= now()) entries.delete(id);
  };
  return {
    register(value: NativeScenePublicationCandidate) {
      sweep();
      if (!value.actorId || !value.scene.id || !value.scene.projectId || !value.capture.nativeCompiled) {
        throw new Error("Native 候选缺少所有者、场景或已验证编译产物");
      }
      assertCapturedSceneDependencies(value.scene.projectId, value.capture, value.scene.id);
      const encoded = JSON.stringify(value), bytes = Buffer.byteLength(encoded);
      const used = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0);
      if (entries.size >= 16 || bytes > 8 * 1024 ** 2 || used + bytes > maximumBytes) {
        throw new Error("Native 验证候选已达限额，请等待旧候选过期");
      }
      const id = randomUUID(), expiresAt = now() + ttl;
      entries.set(id, { value: JSON.parse(encoded) as NativeScenePublicationCandidate, expiresAt, bytes });
      return { candidateId: id, expiresAt: new Date(expiresAt).toISOString() };
    },
    reserve(candidateId: string, actorId: string, expectedScene: SceneSnapshot) {
      sweep();
      const entry = entries.get(candidateId);
      if (!entry || entry.expiresAt <= now() || entry.value.actorId !== actorId
        || entry.value.scene.projectId !== expectedScene.projectId || entry.value.scene.id !== expectedScene.id) {
        throw new Error("Native 验证候选不存在或已过期，请重新验证");
      }
      if (entry.lease) throw new Error("Native 验证候选正在发布，请等待当前请求完成");
      if (!scenePublicationJsonEqual(entry.value.scene, expectedScene)) throw new Error("场景已变化，请重新验证 Native 候选");
      const lease = randomUUID(); entry.lease = lease;
      let settled = false;
      return {
        value: structuredClone(entry.value),
        commit() {
          if (settled || entries.get(candidateId)?.lease !== lease) throw new Error("Native 候选发布租约已失效");
          settled = true; entries.delete(candidateId);
        },
        release() {
          if (settled) return;
          settled = true;
          if (entries.get(candidateId)?.lease === lease) delete entry.lease;
          sweep();
        },
      };
    },
  };
}
