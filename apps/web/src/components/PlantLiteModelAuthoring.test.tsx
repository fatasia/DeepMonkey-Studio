import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlantLiteModelAuthoring } from "./PlantLiteModelAuthoring";
import { createDefaultPlantLiteRequest, setPlantLiteStationEquipment, setPlantLiteStationWorker } from "./plantLiteModelEditing";

describe("PlantLiteModelAuthoring", () => {
  it("presents a lightweight ordered flow editor without exposing a raw JSON editor", () => {
    const html = renderToStaticMarkup(<PlantLiteModelAuthoring value={createDefaultPlantLiteRequest()} onChange={() => undefined} />);
    expect(html).toContain("产线流程");
    expect(html).toContain("添加节点后按列表顺序自动连接");
    expect(html).toContain("装配工位");
    expect(html).toContain("连接至");
    expect(html).toContain("高级参数");
    expect(html).toContain("启用工位班次约束");
    expect(html).toContain("启用工位良率与报废");
    expect(html).toContain("启用设备资源");
    expect(html).toContain("启用人工资源约束");
    expect(html).toContain("启用班次约束");
    expect(html).toContain("能耗、成本与碳排");
    expect(html).toContain("综合电价（元/kWh）");
    expect(html).toContain("计入工位能耗");
    expect(html).toContain("计入搬运能耗");
    expect(html).toContain("方案验收目标");
    expect(html).toContain("用 95% 区间判断达标风险");
    expect(html).toContain("总运行时长（分钟）");
    expect(html).toContain("预热期（分钟）");
    expect(html).toContain("正式统计 480 分钟");
    expect(html).toContain("队列、停机和能耗只积分正式窗口");
    expect(html).toContain("模型文件");
    expect(html).toContain("选择 JSON");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("还不能运行");
  });

  it("reveals real station equipment capacity and MTBF/MTTR controls when configured", () => {
    const request = createDefaultPlantLiteRequest();
    request.model = setPlantLiteStationEquipment(request.model!, "station-a", true);
    const equipment = request.model.resources?.find((resource) => resource.kind === "equipment");
    if (!equipment) throw new Error("missing equipment fixture");
    equipment.capacity = 2;
    equipment.failure = {
      timeToFailure: { kind: "exponential", mean: 480 },
      repairTime: { kind: "deterministic", value: 15 },
    };

    const html = renderToStaticMarkup(<PlantLiteModelAuthoring value={request} onChange={() => undefined} />);
    expect(html).toContain("设备名称");
    expect(html).toContain("设备数");
    expect(html).toContain("有效并行能力 1");
    expect(html).toContain("MTBF 运行间隔（分）");
    expect(html).toContain("MTTR 日历修复时间（分）");
  });

  it("reveals a worker pool with headcount, sharing and shifts without failure or energy controls", () => {
    const request = createDefaultPlantLiteRequest();
    request.model = setPlantLiteStationWorker(request.model!, "station-a", true);
    const pool = request.model.resources?.find((resource) => resource.kind === "worker");
    if (!pool) throw new Error("missing worker fixture");
    pool.capacity = 3;
    pool.availability = { shifts: [{ startMinute: 360, endMinute: 840 }] };

    const html = renderToStaticMarkup(<PlantLiteModelAuthoring value={request} onChange={() => undefined} />);
    expect(html).toContain("人工资源约束");
    expect(html).toContain("人员池名称");
    expect(html).toContain("同班人数");
    expect(html).toContain("启用人员班次");
    expect(html).toContain("06:00–14:00");
    expect(html).toContain("工位、设备、人员均有空闲才会原子派工");
  });

  it("keeps all authored daily shift windows editable instead of dropping everything after the first shift", () => {
    const request = createDefaultPlantLiteRequest();
    const station = request.model!.nodes.find((node) => node.id === "station-a");
    if (!station || station.kind !== "station") throw new Error("missing station fixture");
    station.availability = { shifts: [{ startMinute: 0, endMinute: 480 }, { startMinute: 540, endMinute: 1020 }] };

    const html = renderToStaticMarkup(<PlantLiteModelAuthoring value={request} onChange={() => undefined} />);
    expect(html).toContain("班次 1");
    expect(html).toContain("班次 2");
    expect(html).toContain("00:00–08:00");
    expect(html).toContain("09:00–17:00");
    expect(html).toContain("添加班次");
  });

  it("shows actionable validation instead of allowing an invalid flow to fail silently", () => {
    const request = createDefaultPlantLiteRequest();
    request.model!.nodes = request.model!.nodes.filter((node) => node.kind !== "sink");
    request.model!.edges = request.model!.edges.filter((edge) => edge.to !== "sink");
    const html = renderToStaticMarkup(<PlantLiteModelAuthoring value={request} onChange={() => undefined} />);
    expect(html).toContain("还不能运行");
    expect(html).toContain("必须包含至少一个产出端");
  });
});
