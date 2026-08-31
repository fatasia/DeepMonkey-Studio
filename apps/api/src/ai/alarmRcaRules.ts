export interface AlarmRcaRule {
  id: string;
  title: string;
  alarmPattern: RegExp;
  selectors: Array<{
    kind: "measurement" | "event" | "maintenance";
    pattern: RegExp;
    weight: number;
    missingLabel: string;
  }>;
  validation: Array<{ title: string; instruction: string; acceptanceCriterion: string }>;
}

/** 规则描述常见工业机理线索，但匹配结果始终只是候选原因，不能替代现场根因确认。 */
export const ALARM_RCA_RULES: readonly AlarmRcaRule[] = [
  {
    id: "thermal-load", title: "热负荷或散热能力偏离",
    alarmPattern: /overheat|thermal|temperature|high.?temp|过热|高温|温度/i,
    selectors: [
      { kind: "measurement", pattern: /temp|thermal|温度|热/i, weight: .34, missingLabel: "独立温度测点或热像复测" },
      { kind: "measurement", pattern: /current|power|load|torque|电流|功率|负载|转矩/i, weight: .26, missingLabel: "负载、电流或功率趋势" },
      { kind: "measurement", pattern: /fan|cool|flow|风机|冷却|流量/i, weight: .2, missingLabel: "冷却回路或风机状态" },
      { kind: "event", pattern: /overload|fan|cool|trip|过载|风机|冷却|跳闸/i, weight: .2, missingLabel: "保护、冷却或过载事件" },
    ],
    validation: [
      { title: "独立复测温度", instruction: "使用校验有效的测温设备复测告警点及邻近部位", acceptanceCriterion: "复测值、平台测点和环境温度具有可解释的一致性" },
      { title: "核对负载与散热", instruction: "对齐告警前后的电流、负载、风机和冷却流量", acceptanceCriterion: "确认热偏离是否随负载或散热状态同步变化" },
    ],
  },
  {
    id: "rotating-mechanical", title: "旋转部件机械状态偏离",
    alarmPattern: /bearing|vibration|imbalance|misalign|轴承|振动|不平衡|不对中/i,
    selectors: [
      { kind: "measurement", pattern: /vib|accel|velocity|振动|加速度|速度/i, weight: .4, missingLabel: "多方向振动频谱或包络数据" },
      { kind: "measurement", pattern: /temp|thermal|温度/i, weight: .2, missingLabel: "轴承或壳体温度趋势" },
      { kind: "event", pattern: /start|stop|speed|启动|停机|转速/i, weight: .15, missingLabel: "启停和转速工况" },
      { kind: "maintenance", pattern: /lubric|bearing|align|balance|润滑|轴承|对中|平衡/i, weight: .25, missingLabel: "润滑、轴承与对中维护记录" },
    ],
    validation: [
      { title: "采集振动频谱", instruction: "在相同转速和负载下采集径向、轴向振动频谱", acceptanceCriterion: "获得可重复的特征频率与工况对应关系" },
      { title: "机械点检", instruction: "检查紧固、联轴器、润滑和轴承间隙", acceptanceCriterion: "点检记录包含照片、量值和检验人结论" },
    ],
  },
  {
    id: "electrical-drive", title: "供电、驱动或电气负载偏离",
    alarmPattern: /voltage|current|power|drive|motor|phase|电压|电流|功率|驱动|电机|缺相/i,
    selectors: [
      { kind: "measurement", pattern: /current|amp|power|电流|功率/i, weight: .32, missingLabel: "三相电流与有功功率" },
      { kind: "measurement", pattern: /voltage|phase|frequency|电压|相位|频率/i, weight: .28, missingLabel: "电压、相位和频率质量" },
      { kind: "event", pattern: /drive|trip|overload|phase|变频|驱动|跳闸|过载|缺相/i, weight: .25, missingLabel: "驱动器和保护装置事件码" },
      { kind: "maintenance", pattern: /configuration|parameter|drive|motor|配置|参数|驱动|电机/i, weight: .15, missingLabel: "驱动参数与近期配置变更记录" },
    ],
    validation: [
      { title: "核验电能质量", instruction: "在告警复现工况下测量三相电压、电流、不平衡度和谐波", acceptanceCriterion: "测量结果可与保护定值及设备铭牌范围逐项对照" },
      { title: "读取驱动事件", instruction: "导出驱动器和保护装置的原始事件码及时间戳", acceptanceCriterion: "事件时钟已校准，且与平台告警时间窗对齐" },
    ],
  },
  {
    id: "process-flow", title: "流体回路、阀件或工艺阻力偏离",
    alarmPattern: /pressure|flow|level|valve|pump|压力|流量|液位|阀|泵/i,
    selectors: [
      { kind: "measurement", pattern: /pressure|压力/i, weight: .28, missingLabel: "上下游压力测点" },
      { kind: "measurement", pattern: /flow|level|流量|液位/i, weight: .28, missingLabel: "流量或液位趋势" },
      { kind: "event", pattern: /valve|pump|open|close|阀|泵|开启|关闭/i, weight: .24, missingLabel: "泵阀命令与反馈事件" },
      { kind: "maintenance", pattern: /leak|block|filter|valve|pump|泄漏|堵塞|过滤|阀|泵/i, weight: .2, missingLabel: "泄漏、堵塞、过滤器和阀泵点检记录" },
    ],
    validation: [
      { title: "核对上下游工况", instruction: "同时读取上下游压力、流量以及泵阀命令和反馈", acceptanceCriterion: "明确偏差发生在命令、执行机构还是工艺回路" },
      { title: "检查泄漏与阻塞", instruction: "按安全作业要求检查过滤器、阀位、泄漏和旁路状态", acceptanceCriterion: "形成包含压差、阀位和现场照片的检查记录" },
    ],
  },
  {
    id: "sensor-communication", title: "测量链路或通信质量偏离",
    alarmPattern: /sensor|signal|communication|timeout|quality|传感器|信号|通信|超时|质量/i,
    selectors: [
      { kind: "measurement", pattern: /sensor|signal|quality|flatline|missing|传感器|信号|质量|冻结|缺失/i, weight: .4, missingLabel: "原始测点质量码与采样连续性" },
      { kind: "event", pattern: /communication|timeout|disconnect|reconnect|通信|超时|断开|重连/i, weight: .35, missingLabel: "采集网关和通信链路日志" },
      { kind: "maintenance", pattern: /calibrat|sensor|instrument|校准|传感器|仪表/i, weight: .25, missingLabel: "传感器校准和更换记录" },
    ],
    validation: [
      { title: "旁路仪表复测", instruction: "使用独立仪表与原测点并行采样", acceptanceCriterion: "确认偏差来自真实过程还是测量链路" },
      { title: "核对通信质量", instruction: "检查质量码、丢包、重连和各系统时钟偏差", acceptanceCriterion: "链路异常与告警时间关系可由原始日志复现" },
    ],
  },
  {
    id: "recent-intervention", title: "近期维护或参数变更的时间相关性",
    alarmPattern: /configuration|parameter|calibrat|maint|配置|参数|校准|维护/i,
    selectors: [
      { kind: "maintenance", pattern: /repair|replacement|calibrat|configuration|维修|更换|校准|配置/i, weight: .35, missingLabel: "告警前的维修、更换、校准或配置记录" },
      { kind: "event", pattern: /setpoint|parameter|config|operator|manual|设定|参数|配置|操作|手动/i, weight: .3, missingLabel: "参数下载、设定值或人工操作事件" },
      { kind: "measurement", pattern: /change|step|offset|变化|阶跃|偏移/i, weight: .2, missingLabel: "变更前后的测点阶跃或偏移" },
      { kind: "event", pattern: /restart|start|commission|重启|启动|调试/i, weight: .15, missingLabel: "变更后的重启或投运事件" },
    ],
    validation: [
      { title: "比对变更基线", instruction: "核对告警前后的参数版本、维修记录和投运时间", acceptanceCriterion: "变更项、审批人、版本和生效时间均可追溯" },
      { title: "受控复核变更影响", instruction: "在批准的验证环境中复现或回退单一变更项", acceptanceCriterion: "仅在受控条件下观察到可重复的告警关联，不自动修改现场参数" },
    ],
  },
] as const;
