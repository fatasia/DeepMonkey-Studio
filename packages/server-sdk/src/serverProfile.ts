import type { ServerMetaResponse } from "@bim-studio/contracts";
import { ServerClient, type AuthStore, type Awaitable, type ServerProfile } from "./serverClient.js";

export interface NamedServerProfile extends ServerProfile {
  id: string;
  name: string;
  expectedServerInstanceId?: string;
}

export interface ServerProfileStore {
  load(): Awaitable<NamedServerProfile | undefined>;
  save(profile: NamedServerProfile): Awaitable<void>;
  clear(): Awaitable<void>;
}

export type ServerHandshakeResult =
  | { status: "connected"; profile: NamedServerProfile; meta: ServerMetaResponse }
  | { status: "instance-mismatch"; profile: NamedServerProfile; meta: ServerMetaResponse; expectedServerInstanceId: string }
  | { status: "api-incompatible"; profile: NamedServerProfile; meta: ServerMetaResponse; expectedApiVersion: "1.0" }
  | { status: "unreachable"; profile: NamedServerProfile; message: string };

export function normalizeServerBaseUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError("服务器地址必须是完整的 HTTP(S) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new TypeError("服务器地址只允许 HTTP(S) 协议，且不能包含账号、查询参数或片段");
  }
  url.pathname = "/";
  return url.origin;
}

export function normalizeServerProfile(profile: NamedServerProfile): NamedServerProfile {
  const id = profile.id.trim();
  const name = profile.name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new TypeError("服务器配置 ID 不合法");
  if (!name || name.length > 80) throw new TypeError("服务器名称不能为空且不能超过 80 个字符");
  const expectedServerInstanceId = profile.expectedServerInstanceId?.trim();
  return {
    id,
    name,
    baseUrl: normalizeServerBaseUrl(profile.baseUrl),
    ...(expectedServerInstanceId ? { expectedServerInstanceId } : {})
  };
}

export async function verifyServerProfile(
  profileInput: NamedServerProfile,
  authStore: AuthStore,
  fetch?: typeof globalThis.fetch
): Promise<ServerHandshakeResult> {
  const profile = normalizeServerProfile(profileInput);
  const client = new ServerClient({ profile, authStore, ...(fetch ? { fetch } : {}) });
  try {
    const meta = await client.getMeta();
    if (meta.apiVersion !== "1.0") return { status: "api-incompatible", profile, meta, expectedApiVersion: "1.0" };
    if (profile.expectedServerInstanceId && profile.expectedServerInstanceId !== meta.serverInstanceId) {
      return {
        status: "instance-mismatch",
        profile,
        meta,
        expectedServerInstanceId: profile.expectedServerInstanceId
      };
    }
    return {
      status: "connected",
      profile: { ...profile, expectedServerInstanceId: meta.serverInstanceId },
      meta
    };
  } catch (error) {
    return {
      status: "unreachable",
      profile,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export class ServerProfileController {
  private active: NamedServerProfile | undefined;

  constructor(private readonly store: ServerProfileStore) {}

  async hydrate(): Promise<NamedServerProfile | undefined> {
    const stored = await this.store.load();
    this.active = stored ? normalizeServerProfile(stored) : undefined;
    return this.current();
  }

  current(): NamedServerProfile | undefined {
    return this.active ? { ...this.active } : undefined;
  }

  requireCurrent(): NamedServerProfile {
    const profile = this.current();
    if (!profile) throw new Error("尚未配置服务器，请先完成连接向导");
    return profile;
  }

  async apply(profile: NamedServerProfile): Promise<NamedServerProfile> {
    const normalized = normalizeServerProfile(profile);
    await this.store.save(normalized);
    this.active = normalized;
    return this.requireCurrent();
  }

  async clear(): Promise<void> {
    await this.store.clear();
    this.active = undefined;
  }
}
