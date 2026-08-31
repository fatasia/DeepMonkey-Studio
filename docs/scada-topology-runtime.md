# 拓扑 SCADA 运行态

拓扑编辑器保存设备关系、SCADA 点位和告警阈值；实时值由运行时适配器注入，不写回应用文档。

## 当前能力

- 工业节点：泵、阀门、储罐、电机、PLC、工业仪表。
- 点位配置：点位标签、工程单位、低限/高限和告警级别。
- 数据绑定：节点仍可绑定数据中台的数据集或管道字段。
- 2.5D：节点层高投影、分层拖动与跨层连线不改变原始平面坐标。
- 工艺连线：控制信号、电力、水/液体、空气/气体和物料介质，可显示流向动画，并随端点离线或告警改变状态。
- 运行态：`unknown`、`offline`、`idle`、`running`、`warning`、`alarm`。
- 告警：活动状态、严重级别、消息、确认人/时间，以及拓扑级活动告警和未确认计数；同一活动告警轮询刷新时保留确认状态，恢复后自动清除。

`TopologyEditorPanel.runtimeStates` 接受以节点 ID 为键的 `TopologyScadaRuntimeState`。组件按快照渲染数值、单位、状态色和告警，但 `onChange` 只返回拓扑文档，因此运行态不会污染版本、撤销历史或发布包。

```ts
const runtimeStates = {
  "pump-1": {
    state: "alarm",
    value: 7.2,
    unit: "bar",
    alarm: {
      active: true,
      severity: "critical",
      message: "出口压力高高"
    }
  }
} satisfies Record<string, TopologyScadaRuntimeState>;
```

## 真实边界

这次增强提供 SCADA 画面、运行态契约、活动告警确认、运行健康视图和工艺流向，不等于完整 SCADA 服务端。OPC UA、Modbus TCP、SNMP、TCP/UDP、BACnet、S7、EtherNet/IP、串口、CoAP 已有服务端采样适配器，其中 BACnet、S7、EtherNet/IP 和串口另有受控点位写入；真实设备型号、网络、证书和 PLC 安全策略仍需项目验收。历史库、跨实例告警确认持久化、冗余采集和 PLC 逻辑/物理仿真不在当前核心范围；运行时应由数据中台或边缘网关推入标准化 `runtimeStates`，避免把拓扑文档当作控制系统。
