import type {
  DataConnectionRecord,
  DataConnectionType,
  DataDatasetRecord,
  ParametricCadBindingKind,
  ParametricCadBindingTarget,
  ParametricCadDefinition
} from "@bim-studio/contracts";

export interface ParametricBindingContext {
  dataConnections?: DataConnectionRecord[];
  datasets?: DataDatasetRecord[];
}

export interface ParametricBindingSource {
  key: string;
  label: string;
  connectionName: string;
  datasetName: string;
  fieldLabel: string;
  target: ParametricCadBindingTarget;
}

const DEVICE_CONNECTION_TYPES = new Set<DataConnectionType>([
  "mqtt", "opcua", "modbus", "bacnet", "tcp", "udp", "serial", "s7", "ethernet-ip", "snmp", "coap"
]);

/** 将项目数据目录转换成参数化资产可消费的稳定绑定选项，不读取连接密钥或现场数据。 */
export function listParametricBindingSources(context: ParametricBindingContext): ParametricBindingSource[] {
  const connections = new Map((context.dataConnections ?? []).map((connection) => [connection.id, connection]));
  return (context.datasets ?? []).flatMap((dataset) => {
    const connection = connections.get(dataset.connectionId);
    if (!connection) return [];
    const fields = [...dataset.fields, ...(dataset.computedFields ?? [])];
    return fields.map((field) => {
      const target: ParametricCadBindingTarget = {
        kind: bindingKind(connection.type), connectionId: connection.id, datasetId: dataset.id, field: field.key
      };
      return {
        key: bindingTargetKey(target),
        label: `${connection.name} / ${dataset.name} / ${field.label}`,
        connectionName: connection.name,
        datasetName: dataset.name,
        fieldLabel: field.label,
        target
      };
    });
  }).sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

export function bindingTargetKey(target: ParametricCadBindingTarget): string {
  return `${target.kind}:${target.connectionId}:${target.datasetId}:${target.field}`;
}

/** 保存端复用同一目录解析，拒绝被删除、改名或跨项目伪造的绑定引用。 */
export function assertParametricBindingReferences(definition: ParametricCadDefinition, context: ParametricBindingContext): void {
  const validKeys = new Set(listParametricBindingSources(context).map((source) => source.key));
  for (const [index, binding] of (definition.semanticBindings ?? []).entries()) {
    if (binding.target && !validKeys.has(bindingTargetKey(binding.target))) {
      throw new Error(`semanticBindings[${index}] 的运行绑定已失效，请重新选择数据字段`);
    }
  }
}

function bindingKind(type: DataConnectionType): ParametricCadBindingKind {
  if (type === "simulation") return "simulation-signal";
  if (DEVICE_CONNECTION_TYPES.has(type)) return "device-point";
  return "dataset-field";
}
