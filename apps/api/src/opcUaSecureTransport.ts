/**
 * T24 余项:OPC UA 安全传输(Sign/SignAndEncrypt 握手)的证书与客户端构造。
 *
 * 范围与如实声明:
 * - server 侧:OPCUAServer 声明 Basic256Sha256 时由 node-opcua 内建 PKI 自动生成自签证书;
 *   CA 链/吊销链验收用 OPCUACertificateManager(automaticallyAcceptUnknownCertificate:false)
 *   注入 serverCertificateManager(见 opcUaSecureTransport.test.ts 吊销链三腿)。
 * - client 侧:node-opcua-pki 的 CertificateManager 生成自签证书对
 *   (own/certs + own/private,2.178 依赖树内 6.20.0)。
 * - 用户令牌安全仍沿匿名口径(不覆盖)。
 */
import { OPCUAClient, MessageSecurityMode, SecurityPolicy } from "node-opcua-client";

/** OPC UA 消息安全模式:sign=仅签名(默认,零退化);signAndEncrypt=签名+加密。 */
export type OpcUaMessageSecurityMode = "sign" | "signAndEncrypt";

export interface OpcUaSecureClientFiles {
  readonly certificateFile: string;
  readonly privateKeyFile: string;
}

export interface OpcUaSecureClientOptions {
  readonly endpointUrl: string;
  /** PKI 存储根目录;同 rootDir 二次调用复用既有证书(确定性)。 */
  readonly certificateManagerRootDir: string;
  readonly applicationName?: string;
  readonly applicationUri?: string;
  /** 消息安全模式;缺省 sign(既有 Sign + Basic256Sha256 行为逐位保持)。 */
  readonly messageSecurityMode?: OpcUaMessageSecurityMode;
}

// pki 6.20 约定:私钥固定 own/private/private_key.pem(initialize 自动创建);
// 证书输出经 createSelfSignedCertificate 的 outputFile(绝对路径)。
const ownCertificateFile = (rootDir: string, name: string): string =>
  path.join(rootDir, "own", "certs", `${name}_cert.pem`);
const ownPrivateKeyFile = (rootDir: string): string =>
  path.join(rootDir, "own", "private", "private_key.pem");

import path from "node:path";
import { existsSync } from "node:fs";
import { CertificateManager } from "node-opcua-pki";

/** 创建(或复用)客户端自签证书,返回证书/私钥文件路径。 */
export async function ensureClientCertificate(options: OpcUaSecureClientOptions): Promise<OpcUaSecureClientFiles> {
  const name = (options.applicationName ?? "bim-studio-client").replace(/[^A-Za-z0-9_-]/g, "_");
  const certificateFile = ownCertificateFile(options.certificateManagerRootDir, name);
  const privateKeyFile = ownPrivateKeyFile(options.certificateManagerRootDir);
  const manager = new CertificateManager({ location: options.certificateManagerRootDir, disableFileWatchers: true });
  try {
    await manager.initialize();
    if (!existsSync(certificateFile) || !existsSync(privateKeyFile)) {
      const applicationName = options.applicationName ?? name;
      await manager.createSelfSignedCertificate({
        outputFile: certificateFile,
        subject: `/CN=${applicationName}/O=BIM-Studio`,
        applicationUri: options.applicationUri ?? `urn:${applicationName}:${encodeURIComponent(options.endpointUrl)}`,
        dns: ["localhost"],
        ip: ["127.0.0.1"],
        startDate: new Date(),
        validity: 1095,
      });
    }
    if (!existsSync(certificateFile) || !existsSync(privateKeyFile)) {
      throw new Error(`OPC UA client certificate generation failed: ${certificateFile}`);
    }
    return { certificateFile, privateKeyFile };
  } finally {
    await manager.dispose();
  }
}

/**
 * 以 Basic256Sha256 构造 OPC UA 客户端(不 connect;连接由调用方编排)。
 * 消息安全模式由 options.messageSecurityMode 决定,缺省 Sign(既有行为)。
 */
export async function createSignedOpcUaClient(options: OpcUaSecureClientOptions): Promise<OPCUAClient> {
  const mode = options.messageSecurityMode === undefined ? "sign" : options.messageSecurityMode;
  if (mode !== "sign" && mode !== "signAndEncrypt") {
    throw new Error("OPC UA messageSecurityMode 必须是 sign 或 signAndEncrypt，不能降级为仅签名");
  }
  const files = await ensureClientCertificate(options);
  const securityMode = mode === "signAndEncrypt" ? MessageSecurityMode.SignAndEncrypt : MessageSecurityMode.Sign;
  return OPCUAClient.create({
    endpointMustExist: false,
    securityMode,
    securityPolicy: SecurityPolicy.Basic256Sha256,
    certificateFile: files.certificateFile,
    privateKeyFile: files.privateKeyFile,
    connectionStrategy: { initialDelay: 250, maxDelay: 1_000, maxRetry: 0 },
  });
}
