// Node-RED 健康探针返回类型（实现在 api.ts 内，架构门禁要求 HTTP 集中在 api.ts）。
export interface NodeRedHealth { online: boolean; status?: string; latencyMs?: number; }
