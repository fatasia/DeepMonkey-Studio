/**
 * T24 测试支持模块:node-opcua 内嵌模拟 server(preview/订阅两类联测共用同一形态)。
 *
 * 从 opcUaSimulatedServer.test.ts 逐字抽取(2026-10-02,previewOpcUa 安全联动批),
 * 使 secure 端到端用例真正复用而非复制 harness;仅测试消费,非生产路径。
 *
 * 安全变体:声明 securityPolicies(如 ["Basic256Sha256"])时 node-opcua 内建 PKI 在
 * initialize 自动生成 server 自签证书;allowAnonymous 保持匿名用户令牌口径。
 * 栈实证(2026-10-02):`["None"]` 得到真 None-only 端点面(仅 None|None);
 * `["Basic256Sha256"]` 的 server 仍恒声明 None 端点(None|None + Sign/SignAndEncrypt|Basic256Sha256)。
 * listSessionChannelSecurity:server 侧真实协商观测(engine.getSessions() → session.channel,
 * 公开类型化 API),断言通道上的实际安全策略——非客户端请求参数;仅连接存活期有效。
 */
import type { MessageSecurityMode, SecurityPolicy } from "node-opcua-client";
// 类型引用编译期擦除;注入实例由测试侧构造(node-opcua-certificate-manager 为 apps/api 已声明依赖)。
import type { OPCUACertificateManager } from "node-opcua-certificate-manager";

export interface SimulatedServer {
  endpointUrl: string;
  boundPort: number;
  nodeId: string;
  addTag: (browseName: string, initial: number) => string;
  setValue: (nodeId: string, value: number, timestampMs?: number) => void;
  /**
   * server 侧会话安全观测(类型化公开 API:engine.getSessions() → session.channel):
   * 返回当前带已开通道的活动会话列表,供端到端断言真实协商的安全策略(非客户端请求参数)。
   */
  listSessionChannelSecurity: () => Array<{ securityMode: MessageSecurityMode; securityPolicy: SecurityPolicy }>;
  listActivatedSessionSecurity: () => Array<{ securityMode: MessageSecurityMode; securityPolicy: SecurityPolicy }>;
  shutdown: () => Promise<void>;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startSimulatedServer(
  port: number,
  options: {
    securityPolicies?: Array<keyof typeof SecurityPolicy>;
    /** 注入自管 server 证书管理器(吊销链验收:automaticallyAcceptUnknownCertificate:false);缺省用内建默认。 */
    serverCertificateManager?: OPCUACertificateManager;
  } = {},
): Promise<SimulatedServer> {
  const { OPCUAServer, Variant, DataType, StatusCodes, SecurityPolicy } = await import("node-opcua");
  // 安全变体(T24):声明 Basic256Sha256 时 node-opcua 内建 PKI 在 initialize 自动生成
  // server 自签证书;allowAnonymous 保持匿名用户令牌口径(与订阅源无 user 配置一致)。
  const server = new OPCUAServer({
    port,
    ...(options.securityPolicies
      ? { securityPolicies: options.securityPolicies.map((policy) => SecurityPolicy[policy]), allowAnonymous: true }
      : {}),
    ...(options.serverCertificateManager ? { serverCertificateManager: options.serverCertificateManager } : {}),
  });
  const activatedSessionSecurity: Array<{ securityMode: MessageSecurityMode; securityPolicy: SecurityPolicy }> = [];
  server.on("session_activated", (session) => {
    const channel = session.channel;
    if (channel) activatedSessionSecurity.push({ securityMode: channel.securityMode, securityPolicy: channel.securityPolicy });
  });
  await server.initialize();
  // initialize 后地址空间必然就绪;类型层面可空,显式 fail-closed(tsc 严格检查本模块,测试文件被排除)。
  const addressSpace = server.engine.addressSpace;
  if (!addressSpace) throw new Error("模拟 server 地址空间未初始化");
  const ns = addressSpace.getOwnNamespace();
  const variables = new Map<string, { setValue: (value: number, timestampMs?: number) => void }>();
  const addTag = (browseName: string, initial: number): string => {
    const variable = ns.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      browseName,
      dataType: "Double",
      value: new Variant({ dataType: DataType.Double, value: initial }),
    });
    variables.set(variable.nodeId.toString(), {
      setValue: (value, timestampMs) =>
        variable.setValueFromSource(new Variant({ dataType: DataType.Double, value }), StatusCodes.Good, timestampMs !== undefined ? new Date(timestampMs) : undefined),
    });
    return variable.nodeId.toString();
  };
  const firstNodeId = addTag("Tag1", 0);
  await server.start();
  // port=0 时内核分配临时端口:必须从 server 实际绑定地址解析,不能用入参。
  const boundPort = Number(new URL(server.getEndpointUrl().replace(/^opc\.tcp/i, "http")).port);
  const listSessionChannelSecurity = () =>
    server.engine
      .getSessions()
      .map((session) => session.channel)
      .filter((channel): channel is NonNullable<typeof channel> => channel !== undefined)
      .map((channel) => ({ securityMode: channel.securityMode, securityPolicy: channel.securityPolicy }));
  return {
    endpointUrl: `opc.tcp://127.0.0.1:${boundPort}`,
    boundPort,
    nodeId: firstNodeId,
    addTag,
    setValue: (nodeId, value, timestampMs) => variables.get(nodeId)?.setValue(value, timestampMs),
    listSessionChannelSecurity,
    listActivatedSessionSecurity: () => activatedSessionSecurity.map((channel) => ({ ...channel })),
    shutdown: () => server.shutdown(),
  };
}

/** 先起一个临时 server 占位拿空闲端口,关掉后把端口还给调用方。 */
export async function reserveFreePort(): Promise<number> {
  const probe = await startSimulatedServer(0);
  const port = probe.boundPort;
  await probe.shutdown();
  return port;
}

export function waitForCondition<T>(
  probe: () => T,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  stepMs = 100,
  label = "unlabeled",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const value = probe();
      if (predicate(value)) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`等待条件超时(${timeoutMs}ms): ${label}`));
        return;
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}
