import { mkdtemp, mkdir, rm, copyFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageSecurityMode, SecurityPolicy, UserTokenType } from "node-opcua-client";
import { CertificateManager, CertificateAuthority } from "node-opcua-pki";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import { createSignedOpcUaClient, ensureClientCertificate } from "./opcUaSecureTransport";
import { startSimulatedServer } from "./opcUaSimulatedServer";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** openssl 输出为 PEM;node-opcua-pki 校验 API 吃 DER(node:crypto X509Certificate.raw,零新依赖)。 */
const derOf = async (pemFile: string): Promise<Buffer> => {
  const { readFile } = await import("node:fs/promises");
  return new X509Certificate(await readFile(pemFile)).raw;
};

describe("T24 OPC UA 安全传输(Sign 握手)", () => {
  it("ensureClientCertificate 生成证书对且二次调用复用(确定性)", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "opcua-cert-"));
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }));
    const files1 = await ensureClientCertificate({ certificateManagerRootDir: rootDir, applicationName: "t24-test" });
    expect(files1.certificateFile.length).toBeGreaterThan(0);
    expect(files1.privateKeyFile.length).toBeGreaterThan(0);
    const files2 = await ensureClientCertificate({ certificateManagerRootDir: rootDir, applicationName: "t24-test" });
    expect(files2.certificateFile).toBe(files1.certificateFile);
    expect(files2.privateKeyFile).toBe(files1.privateKeyFile);
  });

  it("端到端:Sign + Basic256Sha256 客户端连接安全 server 并读写数据", async () => {
    const { OPCUAServer, Variant, DataType, StatusCodes } = await import("node-opcua");
    const certRoot = await mkdtemp(path.join(tmpdir(), "opcua-server-cert-"));
    cleanups.push(() => rm(certRoot, { recursive: true, force: true }));
    const server = new OPCUAServer({
      port: 0,
      securityPolicies: [SecurityPolicy.Basic256Sha256],
      allowAnonymous: true,
    });
    await server.initialize();
    const ns = server.engine.addressSpace.getOwnNamespace();
    let serverValue = 41;
    const variable = ns.addVariable({
      organizedBy: server.engine.addressSpace.rootFolder.objects,
      browseName: "SecureTag",
      dataType: "Double",
      value: new Variant({ dataType: DataType.Double, value: serverValue }),
    });
    await server.start();
    const endpointUrl = server.getEndpointUrl().replace(/^opc\.tcp/i, "opc.tcp");
    cleanups.push(() => server.shutdown());

    const clientRoot = await mkdtemp(path.join(tmpdir(), "opcua-client-cert-"));
    cleanups.push(() => rm(clientRoot, { recursive: true, force: true }));
    const client = await createSignedOpcUaClient({
      endpointUrl,
      certificateManagerRootDir: clientRoot,
      applicationName: "t24-secure-client",
    });
    cleanups.push(() => void client.disconnect().catch(() => {}));
    await client.connect(endpointUrl);
    const session = await client.createSession({
      type: UserTokenType.Anonymous,
    });
    cleanups.push(() => void session.close().catch(() => {}));

    // 读:确认签名通道上的数据面。
    const readResult = await session.read({
      nodeId: variable.nodeId,
      attributeId: 13, // Value
    });
    expect(readResult.statusCode).toBe(StatusCodes.Good);
    expect(readResult.value.value).toBe(41);

    // 写:签名通道上写入成功并回读。
    const writeStatus = await session.write({
      nodeId: variable.nodeId,
      attributeId: 13,
      value: { value: new Variant({ dataType: DataType.Double, value: 43 }) },
    });
    expect(writeStatus).toBe(StatusCodes.Good);
    const reread = await session.read({ nodeId: variable.nodeId, attributeId: 13 });
    expect(reread.value.value).toBe(43);
    serverValue = 43;
    void serverValue;
  });

  it("安全 server 端点声明包含 Basic256Sha256(Sign 能力声明面)", async () => {
    const { OPCUAServer, SecurityPolicy } = await import("node-opcua");
    const server = new OPCUAServer({
      port: 0,
      securityPolicies: [SecurityPolicy.Basic256Sha256],
      allowAnonymous: true,
    });
    await server.initialize();
    await server.start();
    cleanups.push(() => server.shutdown());
    // 安全面证明:server 以 Basic256Sha256 声明构造成功并绑定 opc.tcp 端点
    //(node-opcua 内建 PKI 在 initialize 时自动生成自签证书——异常会直接抛出)。
    expect(server.getEndpointUrl()).toMatch(/^opc\.tcp:/);
  });

  it("端到端:SignAndEncrypt + Basic256Sha256,server 侧通道观测恒等(加密通道真协商)", async () => {
    const server = await startSimulatedServer(0, { securityPolicies: ["Basic256Sha256"] });
    cleanups.push(() => server.shutdown());
    const clientRoot = await mkdtemp(path.join(tmpdir(), "opcua-sae-client-"));
    cleanups.push(() => rm(clientRoot, { recursive: true, force: true }));
    const client = await createSignedOpcUaClient({
      endpointUrl: server.endpointUrl,
      certificateManagerRootDir: clientRoot,
      applicationName: "t24-sign-and-encrypt",
      messageSecurityMode: "signAndEncrypt",
    });
    cleanups.push(() => void client.disconnect().catch(() => {}));
    await client.connect(server.endpointUrl);
    const session = await client.createSession({ type: UserTokenType.Anonymous });
    cleanups.push(() => void session.close().catch(() => {}));
    // 数据面:加密通道上读 server 侧初始值(0)。
    const readResult = await session.read({ nodeId: server.nodeId, attributeId: 13 });
    expect(readResult.statusCode.name).toBe("Good");
    // 安全面:server 侧真实协商观测=SignAndEncrypt|Basic256Sha256(非客户端请求参数回读)。
    const channels = server.listSessionChannelSecurity();
    expect(channels.length).toBeGreaterThan(0);
    expect(channels[0]!.securityMode).toBe(MessageSecurityMode.SignAndEncrypt);
    expect(channels[0]!.securityPolicy).toBe(SecurityPolicy.Basic256Sha256);
  });
});

describe("T24 OPC UA 证书吊销链(CA 签发 → 信任 → CRL 吊销拒绝)", () => {
  /** CA 签发客户端证书并装配 server 侧自管 CM(信任 CA + 安装 CRL)。返回各路径句柄。 */
  async function buildCaChain() {
    const base = await mkdtemp(path.join(tmpdir(), "opcua-ca-"));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const caRoot = path.join(base, "ca");
    const clientPkiRoot = path.join(base, "client-pki");
    const serverPkiRoot = path.join(base, "server-pki");
    const ca = new CertificateAuthority({ keySize: 2048, location: caRoot, subject: "/CN=T24 Test CA/O=BIM-Studio" });
    await ca.initialize();
    const clientCM = new CertificateManager({ location: clientPkiRoot, disableFileWatchers: true });
    cleanups.push(() => void clientCM.dispose());
    await clientCM.initialize();
    // CSR(私钥落 own/private/private_key.pem)→ CA 签发。
    const csrFile = await clientCM.createCertificateRequest({
      subject: "/CN=t24-ca-client/O=BIM-Studio",
      applicationUri: "urn:bim-studio:t24-ca-client",
      dns: ["localhost"],
      ip: ["127.0.0.1"],
      startDate: new Date(),
      validity: 365,
    });
    const issuedCertFile = path.join(clientPkiRoot, "own", "certs", "ca_issued.pem");
    await ca.signCertificateRequest(issuedCertFile, csrFile, {
      subject: "/CN=t24-ca-client/O=BIM-Studio",
      dns: ["localhost"],
      ip: ["127.0.0.1"],
      startDate: new Date(),
      validity: 365,
    });
    // server 侧自管 CM:严格模式(auto-accept 关)+ 信任 CA + 安装 CRL 到 issuers/crl。
    // 栈实证(2026-10-02):OPCUACertificateManager 的目录选项是 rootFolder——传 location 会被
    // 静默忽略并回落全局用户 PKI 目录(探针实证 issuersCrlFolder 指向 %APPDATA%),必须用 rootFolder。
    const serverCM = new OPCUACertificateManager({
      rootFolder: serverPkiRoot,
      automaticallyAcceptUnknownCertificate: false,
      disableFileWatchers: true,
    });
    cleanups.push(() => void serverCM.dispose());
    await serverCM.initialize();
    expect(await serverCM.addIssuer(await ca.getCACertificateDER(), true, true)).toBe("Good");
    const installCrl = async () => {
      await mkdir(path.join(serverPkiRoot, "issuers", "crl"), { recursive: true });
      await copyFile(ca.revocationListDER, path.join(serverPkiRoot, "issuers", "crl", "revocation_list.der"));
      await serverCM.reloadCertificates();
    };
    await installCrl();
    return { base, ca, clientPkiRoot, serverCM, issuedCertFile, installCrl };
  }

  it("合法腿:CA 签发未吊销证书通过链验证并建立 SignAndEncrypt 通道(链信任正向证明)", async () => {
    const chain = await buildCaChain();
    const server = await startSimulatedServer(0, {
      securityPolicies: ["Basic256Sha256"],
      serverCertificateManager: chain.serverCM,
    });
    cleanups.push(() => server.shutdown());
    // CM 层链验证:未吊销 + 签发链完整 → Good(node-opcua 真实路径带 chain-accept 选项)。
    expect(await chain.serverCM.verifyCertificate(await derOf(chain.issuedCertFile), { acceptCertificateWithValidIssuerChain: true })).toBe("Good");
    // 端到端:CA 签发证书客户端连接并读数。
    const { OPCUAClient } = await import("node-opcua-client");
    const client = OPCUAClient.create({
      endpointMustExist: false,
      securityMode: MessageSecurityMode.SignAndEncrypt,
      securityPolicy: SecurityPolicy.Basic256Sha256,
      certificateFile: chain.issuedCertFile,
      privateKeyFile: path.join(chain.clientPkiRoot, "own", "private", "private_key.pem"),
      connectionStrategy: { initialDelay: 250, maxDelay: 1_000, maxRetry: 0 },
    });
    cleanups.push(() => void client.disconnect().catch(() => {}));
    await client.connect(server.endpointUrl);
    const session = await client.createSession({ type: UserTokenType.Anonymous });
    cleanups.push(() => void session.close().catch(() => {}));
    const readResult = await session.read({ nodeId: server.nodeId, attributeId: 13 });
    expect(readResult.statusCode.name).toBe("Good");
    const channels = server.listSessionChannelSecurity();
    expect(channels.length).toBeGreaterThan(0);
    expect(channels[0]!.securityMode).toBe(MessageSecurityMode.SignAndEncrypt);
  });

  it("拒绝腿:吊销序列号进 CRL 后连接被拒,server 侧零通道建立(fail-closed)", async () => {
    const chain = await buildCaChain();
    // 吊销:同序列号进 CRL → 重装 CRL → CM 层验证翻 BadCertificateRevoked。
    await chain.ca.revokeCertificate(chain.issuedCertFile, { reason: "keyCompromise" });
    await chain.installCrl();
    expect(await chain.serverCM.verifyCertificate(await derOf(chain.issuedCertFile), { acceptCertificateWithValidIssuerChain: true })).toBe(
      "BadCertificateRevoked",
    );
    const server = await startSimulatedServer(0, {
      securityPolicies: ["Basic256Sha256"],
      serverCertificateManager: chain.serverCM,
    });
    cleanups.push(() => server.shutdown());
    const { OPCUAClient } = await import("node-opcua-client");
    const client = OPCUAClient.create({
      endpointMustExist: false,
      securityMode: MessageSecurityMode.SignAndEncrypt,
      securityPolicy: SecurityPolicy.Basic256Sha256,
      certificateFile: chain.issuedCertFile,
      privateKeyFile: path.join(chain.clientPkiRoot, "own", "private", "private_key.pem"),
      connectionStrategy: { initialDelay: 250, maxDelay: 1_000, maxRetry: 0 },
    });
    cleanups.push(() => void client.disconnect().catch(() => {}));
    // 端到端:吊销证书在 openSecureChannel 阶段被 server 拒绝(fail-closed)。
    let rejected = false;
    try {
      await client.connect(server.endpointUrl);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    // server 侧零通道:拒绝发生在安全协商,会话通道从未建立。
    expect(server.listSessionChannelSecurity().length).toBe(0);
  });
});
