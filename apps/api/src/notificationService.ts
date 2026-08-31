import { createHash, randomUUID } from "node:crypto";
import type {
  NotificationChannel,
  NotificationDeliveryAudit,
  NotificationEvent,
  NotificationRecipient,
  NotificationRule,
  NotificationTemplate,
} from "@bim-studio/contracts";
import { isRetryableNotificationError } from "./notificationTransportError.js";

export interface NotificationTransport {
  deliver(input: { channel: NotificationChannel; recipients: readonly NotificationRecipient[]; title: string; body: string }): Promise<void>;
}

export interface NotificationServiceOptions {
  channels: readonly NotificationChannel[];
  recipients: readonly NotificationRecipient[];
  rules: readonly NotificationRule[];
  templates: readonly NotificationTemplate[];
  transport: NotificationTransport;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** 统一调度只处理选择、限流和审计；渠道密钥和协议实现保持在适配器边界。 */
export class NotificationService {
  private readonly audit: NotificationDeliveryAudit[] = [];
  private readonly deliveryKeys = new Map<string, number>();
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private options: NotificationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  replaceConfiguration(configuration: Pick<NotificationServiceOptions, "channels" | "recipients" | "rules" | "templates">): void {
    this.options = { ...this.options, ...structuredClone(configuration) };
  }

  async dispatch(event: NotificationEvent): Promise<NotificationDeliveryAudit[]> {
    const created: NotificationDeliveryAudit[] = [];
    for (const rule of this.options.rules.filter((item) => matchesRule(item, event))) {
      const suppression = this.suppression(rule, event);
      if (suppression) {
        created.push(this.record(event, { ruleId: rule.id, status: "suppressed", reason: suppression, attempts: 0 }));
        continue;
      }
      const template = this.options.templates.find((item) => item.id === rule.templateId);
      if (!template) {
        created.push(this.record(event, { ruleId: rule.id, status: "skipped", reason: "template_not_found", attempts: 0 }));
        continue;
      }
      const channels = this.options.channels.filter((item) => item.enabled && rule.channelIds.includes(item.id));
      if (!channels.length) {
        created.push(this.record(event, { ruleId: rule.id, status: "skipped", reason: "no_recipient_or_channel", attempts: 0 }));
        continue;
      }
      const title = render(template.title, event);
      const body = render(template.body, event);
      for (const channel of channels) {
        const recipients = recipientsForChannel(channel, rule.recipientIds, this.options.recipients);
        if (!recipients.length) {
          created.push(this.record(event, { ruleId: rule.id, channelId: channel.id, status: "skipped", reason: "no_matching_recipient", attempts: 0 }));
          continue;
        }
        created.push(...await this.deliver(event, rule, channel, recipients, title, body));
      }
    }
    return created;
  }

  listAudit(limit = 200): NotificationDeliveryAudit[] {
    return this.audit.slice(-Math.min(500, Math.max(1, limit))).reverse();
  }

  private async deliver(event: NotificationEvent, rule: NotificationRule, channel: NotificationChannel, recipients: readonly NotificationRecipient[], title: string, body: string): Promise<NotificationDeliveryAudit[]> {
    let attempts = 0;
    let failure = "";
    while (attempts < 3) {
      attempts += 1;
      try {
        await this.options.transport.deliver({ channel, recipients, title, body });
        this.deliveryKeys.set(`${rule.id}:${fingerprint(event)}`, this.now().getTime());
        return recipients.map((recipient) => this.record(event, { ruleId: rule.id, channelId: channel.id, recipientId: recipient.id, status: "delivered", attempts }));
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        if (!isRetryableNotificationError(error)) break;
        if (attempts < 3) await this.sleep(attempts * 100);
      }
    }
    return recipients.map((recipient) => this.record(event, { ruleId: rule.id, channelId: channel.id, recipientId: recipient.id, status: "failed", reason: failure, attempts }));
  }

  private suppression(rule: NotificationRule, event: NotificationEvent): string | undefined {
    const now = this.now();
    if (inQuietHours(rule, now)) return "quiet_hours";
    const recent = this.audit.filter((item) => item.ruleId === rule.id && item.status === "delivered");
    const age = (item: NotificationDeliveryAudit) => now.getTime() - new Date(item.createdAt).getTime();
    const deliveredAt = this.deliveryKeys.get(`${rule.id}:${fingerprint(event)}`);
    if (rule.dedupeWindowSeconds && deliveredAt !== undefined && now.getTime() - deliveredAt <= rule.dedupeWindowSeconds * 1_000) return "deduplicated";
    if (rule.maxDeliveriesPerHour && recent.filter((item) => age(item) <= 3_600_000).length >= rule.maxDeliveriesPerHour) return "rate_limited";
    return undefined;
  }

  private record(event: NotificationEvent, patch: Omit<NotificationDeliveryAudit, "id" | "eventId" | "createdAt">): NotificationDeliveryAudit {
    const result = { id: randomUUID(), eventId: event.id, createdAt: this.now().toISOString(), ...patch };
    this.audit.push(result);
    if (this.audit.length > 2_000) this.audit.splice(0, this.audit.length - 2_000);
    return result;
  }
}

function matchesRule(rule: NotificationRule, event: NotificationEvent): boolean {
  return rule.eventType === event.type && rule.severities.includes(event.severity)
    && Object.entries(rule.target ?? {}).every(([key, value]) => event.target?.[key as keyof NonNullable<NotificationEvent["target"]>] === value);
}

function recipientsForChannel(channel: NotificationChannel, ids: readonly string[], directory: readonly NotificationRecipient[]): NotificationRecipient[] {
  if (channel.deliveryMode === "bot") {
    const groups = ids
      .map((id) => directory.find((item) => item.id === id))
      .filter((item): item is NotificationRecipient => item?.kind === "group");
    const group = groups[0];
    return group ? [group] : ids.length ? [{ id: `bot:${channel.id}`, kind: "group", name: channel.name }] : [];
  }
  return expandRecipients(ids, directory, channel.deliveryMode === "application")
    .filter((recipient) => canDeliverTo(channel, recipient));
}

function expandRecipients(ids: readonly string[], directory: readonly NotificationRecipient[], keepDepartments: boolean): NotificationRecipient[] {
  const byId = new Map(directory.map((item) => [item.id, item]));
  const recipients = new Map<string, NotificationRecipient>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const item = byId.get(id);
    if (!item) return;
    if (item.kind !== "group") recipients.set(item.id, item);
    if (keepDepartments && item.platformDepartmentIds?.length) recipients.set(item.id, item);
    for (const memberId of item.memberIds ?? []) visit(memberId);
  };
  for (const id of ids) visit(id);
  return [...recipients.values()];
}

function canDeliverTo(channel: NotificationChannel, recipient: NotificationRecipient): boolean {
  if (channel.kind === "smtp") return Boolean(recipient.address);
  if (channel.deliveryMode !== "application") return true;
  if (channel.kind === "lark") return Boolean(recipient.platformUserId ?? recipient.address);
  return Boolean(recipient.platformUserId || recipient.platformDepartmentIds?.length);
}

function render(source: string, event: NotificationEvent): string {
  const values = { title: event.title, body: event.body, severity: event.severity, ...(event.data ?? {}) };
  return source.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_match, key) => String(values[key as keyof typeof values] ?? ""));
}

function inQuietHours(rule: NotificationRule, now: Date): boolean {
  const quiet = rule.quietHours;
  if (!quiet) return false;
  const shiftedMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + (quiet.timezoneOffsetMinutes ?? 0) + 1_440) % 1_440;
  const shiftedHour = Math.floor(shiftedMinutes / 60);
  return quiet.startHour <= quiet.endHour ? shiftedHour >= quiet.startHour && shiftedHour < quiet.endHour : shiftedHour >= quiet.startHour || shiftedHour < quiet.endHour;
}

function fingerprint(event: NotificationEvent): string {
  return createHash("sha256").update(JSON.stringify({ type: event.type, severity: event.severity, title: event.title, target: event.target })).digest("hex");
}
