import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  NotificationChannel,
  NotificationCredential,
  NotificationRecipient,
  NotificationRule,
  NotificationTemplate,
} from "@bim-studio/contracts";

type Collection = "recipients" | "rules" | "templates";
interface Configuration {
  channels: NotificationChannel[];
  recipients: NotificationRecipient[];
  rules: NotificationRule[];
  templates: NotificationTemplate[];
}

interface NotificationConfigurationDocument extends Configuration {
  schemaVersion: 1;
  credentials: Record<string, NotificationCredential>;
}

export interface NotificationChannelInput extends Omit<NotificationChannel, "secretRef" | "endpoint"> {
  endpoint?: string;
  credential?: NotificationCredential;
  /** 兼容旧的通用 Webhook 签名写入；SMTP 和企业应用应使用 credential。 */
  secret?: string;
}

export interface NotificationConfigurationSnapshot {
  channels: Array<Omit<NotificationChannel, "endpoint" | "secretRef"> & { endpointConfigured: boolean; endpointMask?: string; secretConfigured: boolean }>;
  recipients: NotificationRecipient[];
  rules: NotificationRule[];
  templates: NotificationTemplate[];
}

/** 配置和密钥同在服务端数据目录；读取快照永远不返回端点原文或密钥。 */
export class NotificationConfigurationStore {
  private readonly filePath: string;
  private document: NotificationConfigurationDocument = emptyDocument();
  private writes = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly initial?: Configuration,
    private readonly externalCredential?: (ref: string) => NotificationCredential | undefined,
  ) {
    this.filePath = path.join(dataDir, "notification-configuration.json");
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.document = normalize(JSON.parse(await readFile(this.filePath, "utf8")) as Partial<NotificationConfigurationDocument>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.document = { ...emptyDocument(), ...structuredClone(this.initial ?? {}) };
      await this.persist();
    }
  }

  configuration(): Configuration {
    const { channels, recipients, rules, templates } = this.document;
    return structuredClone({ channels, recipients, rules, templates });
  }

  snapshot(): NotificationConfigurationSnapshot {
    return {
      channels: this.document.channels.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        name: channel.name,
        enabled: channel.enabled,
        ...(channel.deliveryMode ? { deliveryMode: channel.deliveryMode } : {}),
        endpointConfigured: Boolean(channel.endpoint),
        ...(channel.endpoint ? { endpointMask: mask(channel.endpoint) } : {}),
        secretConfigured: Boolean(channel.secretRef && (this.document.credentials[channel.secretRef] || this.externalCredential?.(channel.secretRef))),
      })),
      recipients: structuredClone(this.document.recipients),
      rules: structuredClone(this.document.rules),
      templates: structuredClone(this.document.templates),
    };
  }

  credential(ref: string): NotificationCredential | undefined {
    return this.document.credentials[ref] ?? this.externalCredential?.(ref);
  }

  async putChannel(input: NotificationChannelInput, create: boolean): Promise<void> {
    await this.mutate(() => {
      const id = requiredId(input.id);
      const index = this.document.channels.findIndex((item) => item.id === id);
      if (create && index >= 0) throw new Error("通知渠道 ID 已存在");
      if (!create && index < 0) throw new Error("通知渠道不存在");
      const previous = index >= 0 ? this.document.channels[index] : undefined;
      const secretRef = previous?.secretRef ?? `notification:${id}:${randomUUID()}`;
      const credential = input.credential ?? (input.secret?.trim() ? { kind: "webhook", signingSecret: input.secret.trim() } : undefined);
      // 显式挑选公开字段，避免把 credential/secret 作为额外属性重复写入渠道记录。
      const channel: NotificationChannel = {
        id,
        kind: input.kind,
        name: requiredText(input.name, "渠道名称"),
        enabled: input.enabled,
        ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
        ...(previous?.endpoint && input.endpoint === undefined ? { endpoint: previous.endpoint } : {}),
        ...(input.endpoint?.trim() ? { endpoint: input.endpoint.trim() } : {}),
        ...(credential || previous?.secretRef ? { secretRef } : {}),
      };
      assertCredentialCompatibility(channel, credential, previous?.secretRef);
      if (credential) this.document.credentials[secretRef] = structuredClone(credential);
      if (index >= 0) this.document.channels[index] = channel;
      else this.document.channels.push(channel);
    });
  }

  async put<T extends { id: string }>(collection: Collection, value: T, create: boolean): Promise<void> {
    await this.mutate(() => {
      const items = this.document[collection] as unknown as T[];
      const id = requiredId(value.id);
      const index = items.findIndex((item) => item.id === id);
      if (create && index >= 0) throw new Error("通知配置 ID 已存在");
      if (!create && index < 0) throw new Error("通知配置不存在");
      if (collection === "rules") {
        assertRuleReferences(value as unknown as NotificationRule, this.document);
      }
      if (index >= 0) items[index] = structuredClone({ ...value, id });
      else items.push(structuredClone({ ...value, id }));
    });
  }

  async remove(collection: "channels" | Collection, id: string): Promise<void> {
    await this.mutate(() => {
      const key = requiredId(id);
      if (collection === "channels") {
        const channel = this.document.channels.find((item) => item.id === key);
        if (!channel) throw new Error("通知渠道不存在");
        if (this.document.rules.some((rule) => rule.channelIds.includes(key))) throw new Error("渠道仍被规则引用");
        this.document.channels = this.document.channels.filter((item) => item.id !== key);
        if (channel.secretRef) delete this.document.credentials[channel.secretRef];
        return;
      }
      if (collection === "recipients" && this.document.rules.some((rule) => rule.recipientIds.includes(key))) throw new Error("收件人仍被规则引用");
      if (collection === "templates" && this.document.rules.some((rule) => rule.templateId === key)) throw new Error("模板仍被规则引用");
      const items = this.document[collection] as Array<{ id: string }>;
      if (!items.some((item) => item.id === key)) throw new Error("通知配置不存在");
      this.document[collection] = items.filter((item) => item.id !== key) as never;
    });
  }

  private async mutate(action: () => void): Promise<void> {
    const operation = this.writes.then(async () => { action(); await this.persist(); });
    this.writes = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.document, null, 2), "utf8");
    await rename(temporary, this.filePath);
  }
}

function emptyDocument(): NotificationConfigurationDocument {
  return { schemaVersion: 1, channels: [], recipients: [], rules: [], templates: [], credentials: {} };
}

function normalize(value: Partial<NotificationConfigurationDocument>): NotificationConfigurationDocument {
  const legacy = (value as { secrets?: Record<string, string> }).secrets ?? {};
  const credentials = value.credentials ?? Object.fromEntries(Object.entries(legacy).map(([ref, signingSecret]) => [ref, { kind: "webhook", signingSecret }]));
  return { schemaVersion: 1, channels: value.channels ?? [], recipients: value.recipients ?? [], rules: value.rules ?? [], templates: value.templates ?? [], credentials };
}

function requiredId(value: string): string {
  return requiredText(value, "通知配置 ID");
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function mask(value: string): string {
  return value.length <= 8 ? "已配置" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function assertCredentialCompatibility(channel: NotificationChannel, credential: NotificationCredential | undefined, previousRef: string | undefined): void {
  const requiresApplicationCredential = channel.kind === "smtp" || channel.deliveryMode === "application";
  if (requiresApplicationCredential && !credential && !previousRef) throw new Error("SMTP 或企业应用渠道必须写入凭据");
  if (!credential || !requiresApplicationCredential) return;
  if (credential.kind !== channel.kind) throw new Error("渠道与凭据类型不匹配");
}

function assertRuleReferences(rule: NotificationRule, configuration: Configuration): void {
  requiredText(rule.eventType, "事件类型");
  if (!rule.channelIds?.length) throw new Error("通知规则至少需要一个投递渠道");
  if (!rule.recipientIds?.length) throw new Error("通知规则至少需要一个收件人");
  if (!configuration.templates.some((item) => item.id === rule.templateId)) throw new Error("通知规则引用的模板不存在");
  if (rule.channelIds.some((id) => !configuration.channels.some((item) => item.id === id))) throw new Error("通知规则引用的渠道不存在");
  if (rule.recipientIds.some((id) => !configuration.recipients.some((item) => item.id === id))) throw new Error("通知规则引用的收件人不存在");
}
