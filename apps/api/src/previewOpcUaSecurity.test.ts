/**
 * T24 previewOpcUa 安全联动验收(2026-10-02):
 * preview 链可选 security(连接配置扁平字段 certificateManagerRootDir/applicationName)
 * → createSignedOpcUaClient(Sign + Basic256Sha256);无配置路径零退化(None 匿名逐位不变)。
 *
 * 验证设计(基于 node-opcua 2.178 端点声明面的实证,见报告"栈实证"):
 * preview 连接是瞬态的(previewOpcUa 返回前 session 已关闭),无法像持久订阅那样在连接存活期做
 * server 侧通道观测(listSessionChannelSecurity 在此恒为空,如实声明)。实证基线:
 * - `securityPolicies:["None"]` 的 server 是**真 None-only**(findMatchingEndpoints 仅 None|None),
 *   Sign 客户端连接必被拒:"Cannot find an Endpoint matching security mode: SIGN policy:
 *   #Basic256Sha256"(client 侧 findEndpoint 严格匹配);
 * - `securityPolicies:["Basic256Sha256"]` 的 server **仍声明 None 端点**(None|None +
 *   Sign|Basic256Sha256 + SignAndEncrypt|Basic256Sha256)——底座/路由批注释"仅声明 Basic256Sha256、
 *   None 客户端被拒"的前提不准确,本批已在同族文件内纠正(断言本身有效:server 侧协商通道恒等断言)。
 * 四用例由此互锁:
 * 1. 无配置零退化:None-only server + 连接无 rootDir → 预览成功取值(若联动误把无配置切签名,
 *    签名客户端会被 None-only server 拒绝,见用例 3 的拒绝证据);
 * 2. secure 端到端数据面:Basic256Sha256 server + 配置 rootDir → 预览成功取值;
 * 3. secure 链路证明:None-only server + 配置 rootDir → **必须被拒**且错误点名请求策略
 *    SIGN + Basic256Sha256——拒绝本身即证明 rootDir 配置确实驱动了签名客户端构造
 *    (比"server 拒绝 None 客户端"更强:node-opcua secure server 恒声明 None,None 客户端永不被拒);
 * 4. fail-closed:rootDir 空白 / applicationName 非文本 → 显式拒绝,先于连接尝试,
 *    绝不静默降级 None。
 * 1+3 证明"配置键 → 客户端构造"的判据真实可判;2 证明签名握手端到端可用。
 *
 * 模拟 server 复用 opcUaSimulatedServer 测试形态(同一支持模块,非复制)。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import { previewDataset } from "./dataIntegration.js";
import { startSimulatedServer } from "./opcUaSimulatedServer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("T24 previewOpcUa 安全联动(Sign + Basic256Sha256 端到端)", () => {
  it("无配置零退化:None-only server,连接不带 certificateManagerRootDir → None 通道预览取值", { timeout: 60_000 }, async () => {
    const server = await startSimulatedServer(0, { securityPolicies: ["None"] });
    cleanups.push(() => server.shutdown());
    server.setValue(server.nodeId, 42);
    const preview = await previewDataset(
      {} as never,
      opcUaConnection({ url: server.endpointUrl }),
      dataset(server.nodeId),
    );
    // 数据面:None 匿名路径与联动前同形读值。None-only server 对签名客户端必拒(用例 3 实证
    // 该拒绝真实存在),故成功即证明无配置路径未被误切签名。
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({ nodeId: server.nodeId, value: 42, status: "Good" });
  });

  it("secure 端到端数据面:Basic256Sha256 server,配置 rootDir → 签名通道预览取值", { timeout: 60_000 }, async () => {
    const clientRoot = await mkdtemp(path.join(tmpdir(), "opcua-preview-cert-"));
    cleanups.push(() => rm(clientRoot, { recursive: true, force: true }));
    const server = await startSimulatedServer(0, { securityPolicies: ["Basic256Sha256"] });
    cleanups.push(() => server.shutdown());
    server.setValue(server.nodeId, 7);
    const preview = await previewDataset(
      {} as never,
      opcUaConnection({ url: server.endpointUrl, certificateManagerRootDir: clientRoot, applicationName: "t24-preview-secure" }),
      dataset(server.nodeId),
    );
    // 数据面:签名握手 + 读值成功。签名客户端构造由用例 3 证明(拒绝信息点名 SIGN policy),
    // 与本用例同一构造路径,故本用例即签名通道端到端。
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({ nodeId: server.nodeId, value: 7, status: "Good" });
  });

  it("secure 链路证明:None-only server + 配置 rootDir → 必须被拒,错误点名 SIGN + Basic256Sha256", { timeout: 60_000 }, async () => {
    const clientRoot = await mkdtemp(path.join(tmpdir(), "opcua-preview-cert-"));
    cleanups.push(() => rm(clientRoot, { recursive: true, force: true }));
    const server = await startSimulatedServer(0, { securityPolicies: ["None"] });
    cleanups.push(() => server.shutdown());
    // 正向证明"配置键 → 签名客户端":None-only server 只接受 None 端点,预览若仍走 None 会成功;
    // 被拒且错误信息点名请求策略 SIGN + Basic256Sha256,即签名客户端被真实构造并使用。
    await expect(
      previewDataset(
        {} as never,
        opcUaConnection({ url: server.endpointUrl, certificateManagerRootDir: clientRoot, applicationName: "t24-preview-proof" }),
        dataset(server.nodeId),
      ),
    ).rejects.toThrow(/Cannot find an Endpoint matching[\s\S]*Basic256Sha256/i);
  });

  it("preserves SignAndEncrypt through the persisted preview configuration", { timeout: 60_000 }, async () => {
    const clientRoot = await mkdtemp(path.join(tmpdir(), "opcua-preview-encrypted-"));
    cleanups.push(() => rm(clientRoot, { recursive: true, force: true }));
    const server = await startSimulatedServer(0, { securityPolicies: ["Basic256Sha256"] });
    cleanups.push(() => server.shutdown());
    server.setValue(server.nodeId, 73);
    const preview = await previewDataset(
      {} as never,
      opcUaConnection({ url: server.endpointUrl, certificateManagerRootDir: clientRoot, securityMode: " signAndEncrypt " }),
      dataset(server.nodeId),
    );
    expect(preview.rows[0]).toMatchObject({ nodeId: server.nodeId, value: 73, status: "Good" });
    const { MessageSecurityMode, SecurityPolicy } = await import("node-opcua-client");
    expect(server.listActivatedSessionSecurity()).toEqual([
      { securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 },
    ]);
    expect(server.listSessionChannelSecurity()).toEqual([]);
  });

  it.each(["none", "encrypt", "", false])("rejects invalid preview securityMode %s before connecting", async (securityMode) => {
    await expect(previewDataset(
      {} as never,
      opcUaConnection({ url: "opc.tcp://127.0.0.1:1", certificateManagerRootDir: "pki", securityMode }),
      dataset("ns=2;s=Tag1"),
    )).rejects.toThrow(/securityMode/);
  });

  it("rejects an explicit encrypted preview without a certificate directory", async () => {
    await expect(previewDataset(
      {} as never, opcUaConnection({ url: "opc.tcp://127.0.0.1:1", securityMode: "signAndEncrypt" }), dataset("ns=2;s=Tag1"),
    )).rejects.toThrow(/certificateManagerRootDir/);
  });

  it("fail-closed:rootDir 空白 / applicationName 非文本 → 显式拒绝,先于连接尝试,绝不静默降级 None", async () => {
    // 端点为不可达占位地址:若校验不在连接前发生,报错将是 endpoint 类错误而非配置校验。
    await expect(
      previewDataset({} as never, opcUaConnection({ url: "opc.tcp://127.0.0.1:1", certificateManagerRootDir: "   " }), dataset("ns=2;s=Tag1")),
    ).rejects.toThrow(/certificateManagerRootDir/);
    await expect(
      previewDataset({} as never, opcUaConnection({ url: "opc.tcp://127.0.0.1:1", certificateManagerRootDir: "pki", applicationName: 123 }), dataset("ns=2;s=Tag1")),
    ).rejects.toThrow(/applicationName/);
  });
});

function opcUaConnection(config: DataConnectionRecord["config"]): DataConnectionRecord {
  return {
    id: "connection:opcua-preview",
    projectId: "project:1",
    name: "opcua",
    type: "opcua",
    enabled: true,
    config,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
}

function dataset(sourceKey: string): DataDatasetRecord {
  return {
    id: "dataset:opcua-preview",
    projectId: "project:1",
    connectionId: "connection:opcua-preview",
    name: "OPC UA 预览",
    refreshSeconds: 0,
    fields: [],
    sourceKey,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
}
