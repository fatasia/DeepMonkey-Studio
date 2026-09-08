import { describe, expect, it } from "vitest";
import { formatAuditActor, formatServiceLogMessage } from "./serviceLogFormat";

describe("formatServiceLogMessage", () => {
  it("解析 pino 请求完成日志为 方法 路径 状态 耗时", () => {
    const line = 'request completed · {"level":30,"time":1788123456789,"reqId":"req-1zf","res":{"statusCode":200},"responseTime":3.146,"req":{"method":"GET","url":"/api/projects"}}';
    expect(formatServiceLogMessage(line)).toBe("request completed GET /api/projects 200 3.15ms");
  });

  it("解析入口请求日志为 方法 路径", () => {
    const line = 'incoming request · {"level":30,"req":{"method":"POST","url":"/api/scenarios"},"reqId":"req-2ab"}';
    expect(formatServiceLogMessage(line)).toBe("incoming request POST /api/scenarios");
  });

  it("无请求对象但带状态与耗时也能压缩", () => {
    expect(formatServiceLogMessage('done · {"res":{"statusCode":503},"elapsedTime":1204}')).toBe("done 503 1204ms");
  });

  it("尾部不是 JSON 时保留原文，不吞信息", () => {
    const line = "database connection lost to primary";
    expect(formatServiceLogMessage(line)).toBe(line);
  });

  it("JSON 无可识别字段时保留原文", () => {
    const line = 'watch · {"level":30,"pid":1234}';
    expect(formatServiceLogMessage(line)).toBe(line);
  });

  it("纯 URL 消息压缩为路径", () => {
    expect(formatServiceLogMessage('GET · {"url":"/api/health"}')).toBe("GET /api/health");
  });

  it.each(["null", "[]", '[{"responseTime":3}]', "false", "42", '"hello"'])
  ("合法 JSON 非对象 %s 不崩溃且保留原文", (payload) => {
    const line = `watch · ${payload}`;
    expect(formatServiceLogMessage(line)).toBe(line);
  });

  it.each([
    '{"req":{"method":12,"url":{"path":"/api"}},"responseTime":3}',
    '{"req":[],"responseTime":3}',
    '{"res":"200","responseTime":3}',
    '{"res":{"statusCode":"200"},"responseTime":3}',
    '{"res":{"statusCode":200},"responseTime":1e999}',
    '{"res":{"statusCode":200},"responseTime":-1}',
    '{"res":{"statusCode":200},"responseTime":"3"}',
  ])("格式异常字段不冒充正常摘要：%s", (payload) => {
    const line = `done · ${payload}`;
    expect(formatServiceLogMessage(line)).toBe(line);
  });

  it.each([
    '{"res":{"statusCode":503},"err":{"message":"ECONNRESET","stack":"at worker"}}',
    '{"res":{"statusCode":409},"conflict":{"revision":7}}',
    '{"req":{"method":"POST","url":"/api","body":{"attempt":3}}}',
    '{"res":{"statusCode":500,"detail":"database unavailable"}}',
  ])("错误和额外排障信息必须保留在可见原文：%s", (payload) => {
    const line = `failed · ${payload}`;
    expect(formatServiceLogMessage(line)).toBe(line);
  });

  it("零耗时与缺少头部也能形成有效摘要", () => {
    expect(formatServiceLogMessage(' · {"res":{"statusCode":204},"responseTime":0}')).toBe("204 0.00ms");
  });
});

describe("formatAuditActor", () => {
  it("真实用户名直显", () => {
    expect(formatAuditActor("admin", "系统")).toBe("admin");
  });

  it("空值沿用系统标签", () => {
    expect(formatAuditActor(null, "系统")).toBe("系统");
    expect(formatAuditActor(undefined, "System")).toBe("System");
    expect(formatAuditActor("", "系统")).toBe("系统");
    expect(formatAuditActor("  ", "系统")).toBe("系统");
  });

  it.each(["8E0A9C2E-1B4D-4A6E-9F2C-D41B72E5A391", "0f0a5a0a-5a0a-4a0a-9a0a-2a0a5a0a7a0a"])
  ("UUID %s 不误归为系统操作", (actor) => {
    expect(formatAuditActor(actor, "系统")).toBe(actor);
  });
});
