import { useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, Clipboard, KeyRound, LoaderCircle, RefreshCw, ServerCog, ShieldCheck, Wrench } from "lucide-react";
import { api } from "../api.js";
import type { McpInspection } from "../apiClients/mcpApi.js";
import { translate as tr, type AppLocale } from "../i18n.js";
import { copyDocumentationCode } from "./DocsCenterClipboard.js";

export interface McpSettingsClient { inspectMcp(signal?: AbortSignal): Promise<McpInspection> }

export function createMcpClientConfig(endpoint: string): string {
  return JSON.stringify({
    mcpServers: {
      "deep-monkey-studio": {
        type: "http",
        url: endpoint,
        headers: { Authorization: "Bearer ${BIM_STUDIO_TOKEN}" },
      },
    },
  }, null, 2);
}

export function McpSettingsPanel({ locale, client = api }: { locale: AppLocale; client?: McpSettingsClient }) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const [inspection, setInspection] = useState<McpInspection>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");

  const load = () => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void client.inspectMcp(controller.signal).then(setInspection).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return controller;
  };
  useEffect(() => { const controller = load(); return () => controller.abort(); }, [client]);

  const config = useMemo(() => createMcpClientConfig(inspection?.endpoint ?? "/api/mcp"), [inspection?.endpoint]);
  const capabilities = useMemo(() => new Map(inspection?.capabilities.map(item => [item.id, item]) ?? []), [inspection]);

  async function copyConfig() {
    try {
      await copyDocumentationCode(config);
      setCopyState("done");
    } catch {
      setCopyState("failed");
    }
  }

  if (loading && !inspection) return <div className="mcp-state"><LoaderCircle className="spin" /><strong>{t("正在检查 MCP 连接", "Checking MCP connection")}</strong><span>{t("读取当前端点、登录身份和能力目录", "Reading the current endpoint, identity, and capability catalog")}</span></div>;
  if (error && !inspection) return <div className="mcp-state is-error"><CircleAlert /><strong>{t("无法连接 MCP 服务", "MCP service unavailable")}</strong><span>{error}</span><button type="button" onClick={load}><RefreshCw />{t("重新检查", "Retry")}</button></div>;

  const data = inspection!;
  return (
    <div className="mcp-settings">
      {error && <div className="mcp-inline-error" role="alert"><CircleAlert /><span>{error}</span><button type="button" onClick={load}>{t("重试", "Retry")}</button></div>}
      <section className="mcp-overview">
        <header><div className="mcp-status-icon"><ServerCog /></div><span><strong>{t("MCP 接入", "MCP connection")}</strong><small>{data.serverName} · v{data.serverVersion}</small></span><i><Check />{t("连接正常", "Connected")}</i></header>
        <div className="mcp-facts">
          <article><small>{t("服务端点", "Endpoint")}</small><code title={data.endpoint}>{data.endpoint}</code></article>
          <article><small>{t("协议版本", "Protocol")}</small><strong>{data.protocolVersion}</strong></article>
          <article><small>{t("当前身份", "Identity")}</small><strong>{data.authenticated ? t("登录会话令牌", "Signed-in session token") : t("未检测到令牌", "No token detected")}</strong></article>
          <article><small>{t("已授权工具", "Authorized tools")}</small><strong>{data.tools.length}</strong></article>
        </div>
      </section>

      <div className="mcp-grid">
        <section className="mcp-card mcp-quickstart">
          <header><span><Clipboard /><strong>{t("客户端配置", "Client configuration")}</strong></span><button type="button" onClick={() => void copyConfig()}><Clipboard />{copyState === "done" ? t("已复制", "Copied") : t("复制 JSON", "Copy JSON")}</button></header>
          <p>{t("把下面配置加入支持 HTTP MCP 的客户端，并将 BIM_STUDIO_TOKEN 放入客户端的安全环境变量或密钥存储。", "Add this to an HTTP MCP client and keep BIM_STUDIO_TOKEN in its secure environment or secret store.")}</p>
          <pre><code>{config}</code></pre>
          {copyState === "failed" && <em>{t("复制失败，请手动选择配置文本。", "Copy failed. Select the configuration text manually.")}</em>}
          <ol>
            <li>{t("登录 Studio；令牌由 /api/auth/login 返回。", "Sign in to Studio; /api/auth/login returns the token.")}</li>
            <li>{t("设置 BIM_STUDIO_TOKEN，保存配置后重启 MCP 客户端。", "Set BIM_STUDIO_TOKEN, save the configuration, then restart the MCP client.")}</li>
            <li>{t("先执行 tools/list，再选择项目调用工具。", "Run tools/list first, then invoke a tool for an authorized project.")}</li>
          </ol>
        </section>

        <section className="mcp-card mcp-security">
          <header><span><ShieldCheck /><strong>{t("安全与执行语义", "Security & execution")}</strong></span></header>
          <ul>
            <li><KeyRound /><span><b>{t("认证", "Authentication")}</b>{t("使用当前账号的 Bearer 令牌；页面不读取或显示明文。", "Uses the current account Bearer token; this page never reveals it.")}</span></li>
            <li><ShieldCheck /><span><b>{t("权限", "Authorization")}</b>{t("工具按登录角色和项目授权过滤，客户端参数不能自报身份。", "Tools are filtered by role and project access; clients cannot self-assert identity.")}</span></li>
            <li><CircleAlert /><span><b>{t("审批", "Approval")}</b>{t("工具结果中的建议动作只是提案；requiresConfirmation 为 true 时必须由产品审批后执行。", "Suggested actions are proposals; requiresConfirmation actions need product approval before execution.")}</span></li>
            <li><RefreshCw /><span><b>{t("事务", "Transactions")}</b>{t("每次调用返回 trace、决策状态和证据；当前 MCP 不开放裸场景写事务。", "Every call returns trace, decision status, and evidence; raw scene write transactions are not exposed.")}</span></li>
          </ul>
        </section>
      </div>

      <section className="mcp-card mcp-catalog">
        <header><span><Wrench /><strong>{t("当前可用能力", "Available capabilities")}</strong></span><button type="button" disabled={loading} onClick={load}><RefreshCw className={loading ? "spin" : ""} />{t("检查连接", "Check connection")}</button></header>
        <div className="mcp-catalog-summary"><span><b>{data.tools.length}</b>{t("工具", " tools")}</span><span><b>{data.resources.length}</b>{t("资源", " resources")}</span><small>{t("列表基于当前登录账号实时读取", "Live result for the signed-in account")}</small></div>
        {data.resources.length > 0 && <div className="mcp-resource-list">{data.resources.map(resource => <article key={resource.uri}><span><strong>{resource.title ?? resource.name}</strong><small>{resource.description}</small></span><code title={resource.uri}>{resource.uri}</code></article>)}</div>}
        {data.tools.length ? <div className="mcp-tool-list">{data.tools.map(tool => {
          const capability = capabilities.get(tool.name.replace(/^industrial\./, ""));
          return <article key={tool.name}><span><strong>{tool.title}</strong><code>{tool.name}</code></span><div>{capability?.permissions.map(permission => <i key={permission}>{permission}</i>)}</div><small>{tool.annotations?.readOnlyHint ? t("只读 · 幂等", "Read-only · idempotent") : t("执行能力 · 结果可追溯", "Executable · traceable")}</small></article>;
        })}</div> : <div className="mcp-empty"><Wrench /><strong>{t("当前账号没有可用工具", "No tools available to this account")}</strong><span>{t("检查账号角色与项目授权后重试。", "Check the account role and project access, then retry.")}</span></div>}
        {data.resourcesSupported && data.resources.length === 0 && <div className="mcp-resource-empty">{t("暂无活跃编辑器资源。打开场景、二维页面或拓扑编辑器后再检查。", "No active editor resources. Open a scene, dashboard, or topology editor, then check again.")}</div>}
      </section>

      <details className="mcp-troubleshooting"><summary>{t("常见错误", "Common errors")}</summary><dl>
        <div><dt>401</dt><dd>{t("令牌缺失或过期：重新登录并更新客户端密钥。", "Missing or expired token: sign in again and update the client secret.")}</dd></div>
        <div><dt>403</dt><dd>{t("角色或项目无权限：让管理员补充项目授权。", "Role or project denied: ask an administrator to grant project access.")}</dd></div>
        <div><dt>-32600</dt><dd>{t("协议头与 JSON-RPC 方法不一致：通用客户端请使用兼容握手，不要固定现代路由头。", "Protocol headers do not match the JSON-RPC method: use the compatibility handshake in generic clients.")}</dd></div>
        <div><dt>-32602</dt><dd>{t("参数不符合工具 schema：先刷新 tools/list，再按 inputSchema 组装输入。", "Arguments do not match the tool schema: refresh tools/list and follow inputSchema.")}</dd></div>
      </dl></details>
    </div>
  );
}
