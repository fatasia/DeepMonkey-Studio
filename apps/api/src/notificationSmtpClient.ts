import nodemailer from "nodemailer";
import type { NotificationRecipient, SmtpNotificationCredential } from "@bim-studio/contracts";
import { NotificationTransportError } from "./notificationTransportError.js";

export interface NotificationSmtpClient {
  send(input: { credential: SmtpNotificationCredential; recipients: readonly NotificationRecipient[]; title: string; body: string }): Promise<void>;
}

export const nodemailerNotificationSmtpClient: NotificationSmtpClient = {
  async send({ credential, recipients, title, body }) {
    const addresses = recipients.map((item) => item.address).filter(isText);
    if (!addresses.length) throw new NotificationTransportError("smtp_recipient_missing", false);
    try {
      const transporter = nodemailer.createTransport({
        host: credential.host,
        port: credential.port,
        secure: credential.secure ?? credential.port === 465,
        ...(credential.username ? { auth: { user: credential.username, pass: credential.password ?? "" } } : {}),
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 10_000,
      });
      await transporter.sendMail({ from: credential.from, to: addresses.join(","), subject: title, text: body });
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "send_failed";
      const retryable = ["ECONNECTION", "ECONNRESET", "ETIMEDOUT", "ESOCKET"].includes(code);
      throw new NotificationTransportError(`smtp_${code}`, retryable, error instanceof Error ? error.message : code);
    }
  },
};

function isText(value: string | undefined): value is string {
  return Boolean(value?.trim());
}
