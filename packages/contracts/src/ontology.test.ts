import { describe, expect, it } from "vitest";
import {
  canTransitionOntologyStatus,
  newOntologyPackage,
  ONTOLOGY_PUBLISH_GATE_LABELS,
  ontologyPackageFingerprint,
  validateOntologyPackageShape,
  validateOntologyPublishGate,
  type OntologyActionType,
  type OntologyObjectType,
  type OntologyPackage,
  type OntologyPublishContext,
  type OntologyRelationType,
} from "./ontology.js";

const NOW = "2026-09-29T08:00:00.000Z";

/** 最小可发布包：两对象、一条有证据关系、一个只读行动、一条通过的黄金问题。 */
function buildPublishablePackage(): OntologyPackage {
  const device: OntologyObjectType = {
    id: "o1",
    key: "Device",
    label: "设备",
    domain: "manufacturing",
    primaryKeys: ["device_id"],
    properties: [
      { key: "device_id", label: "设备编号", type: "string", confirmed: true },
      { key: "device_name", label: "设备名称", type: "string", confirmed: true },
    ],
    sourceBindings: [
      { kind: "dataset", sourceId: "ds-devices", fieldMappings: [{ propertyKey: "device_id", fieldKey: "device_id" }, { propertyKey: "device_name", fieldKey: "name" }], schemaFingerprint: "fp-devices-v1" },
    ],
    aliases: ["机台"],
    identityMappings: [{ objectKey: "Device", canonicalId: "press-07", sources: [{ sourceKind: "dataset", sourceId: "ds-devices", externalId: "PRESS-07" }] }],
    status: "review",
    version: 1,
    owner: "alice",
  };
  const event: OntologyObjectType = {
    ...device,
    id: "o2",
    key: "MaintenanceEvent",
    label: "维护事件",
    primaryKeys: ["event_id"],
    properties: [{ key: "event_id", label: "事件编号", type: "string", confirmed: true }],
    sourceBindings: [{ kind: "manual", sourceId: "manual-maintenance", fieldMappings: [{ propertyKey: "event_id", fieldKey: "case_id" }], note: "工单系统人工登记口径" }],
    identityMappings: [],
    aliases: [],
  };
  const relation: OntologyRelationType = {
    id: "r1",
    key: "device_triggers_event",
    label: "设备触发维护事件",
    sourceObject: "Device",
    targetObject: "MaintenanceEvent",
    cardinality: "one-to-many",
    direction: "directed",
    properties: [],
    keyMapping: { sourceField: "device_id", targetField: "event_id" },
    source: { kind: "dataset", sourceId: "ds-devices", note: "工单表 device_id 外键印证" },
    evidence: [{ source: "ds-devices 预览 200 行抽样", sampleCount: 200, recordedAt: NOW }],
    status: "review",
    version: 1,
  };
  const action: OntologyActionType = {
    id: "a1",
    key: "diagnose_device",
    label: "生成设备诊断报告",
    boundObject: "Device",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } } },
    outputSchema: { type: "object", properties: { report: { type: "string" } } },
    toolBinding: { kind: "capability", id: "data.query.deviceDiagnosis", version: "1.0.0" },
    preconditions: [{ label: "设备存在且在线" }],
    effect: "read",
    riskLevel: "low",
    approvalRequired: false,
    idempotencyRequired: false,
    impactScope: ["Device"],
    authorizedScopes: ["project:read"],
    evidenceRequired: true,
    status: "review",
    version: 1,
  };
  const pkg = newOntologyPackage("manufacturing", "alice", NOW);
  pkg.id = "pkg-1";
  pkg.name = "产线设备本体";
  pkg.revision = 3;
  pkg.objects = [device, event];
  pkg.relations = [relation];
  pkg.actions = [action];
  pkg.goldenQuestions = [{ id: "q1", question: "设备 press-07 最近的异常和关联工单", passed: true, passedAt: NOW }];
  pkg.evidence = [{ source: "ds-devices", fingerprint: "abc123", recordedAt: NOW }];
  pkg.impactReviewed = true;
  pkg.impactReviewedBy = "bob";
  pkg.status = "review";
  return pkg;
}

function publishableContext(): OntologyPublishContext {
  return {
    capabilities: [{ id: "data.query.deviceDiagnosis", version: "1.0.0", kind: "query" }],
    datasetSchemas: { "ds-devices": "fp-devices-v1" },
  };
}

describe("ontology status machine", () => {
  it("allows draft → review → published → retired and rejects illegal jumps", () => {
    expect(canTransitionOntologyStatus("draft", "review")).toBe(true);
    expect(canTransitionOntologyStatus("review", "published")).toBe(true);
    expect(canTransitionOntologyStatus("review", "draft")).toBe(true);
    expect(canTransitionOntologyStatus("published", "retired")).toBe(true);
    expect(canTransitionOntologyStatus("published", "draft")).toBe(true);
    expect(canTransitionOntologyStatus("draft", "published")).toBe(false);
    expect(canTransitionOntologyStatus("retired", "draft")).toBe(false);
    expect(canTransitionOntologyStatus("retired", "published")).toBe(false);
  });
});

describe("ontology package shape validation", () => {
  it("accepts a coherent package without errors", () => {
    expect(validateOntologyPackageShape(buildPublishablePackage())).toEqual([]);
  });
  it("rejects duplicate object keys, dangling references and repeated canonical ids", () => {
    const pkg = buildPublishablePackage();
    pkg.objects.push({ ...pkg.objects[0]!, id: "o1-clone" });
    pkg.relations[0]!.targetObject = "Ghost";
    pkg.identityMappings = [{ objectKey: "Device", canonicalId: "press-07", sources: [{ sourceKind: "dataset", sourceId: "ds-devices", externalId: "PRESS-07" }] }];
    const errors = validateOntologyPackageShape(pkg);
    expect(errors.some((item) => item.includes("对象标识 Device 在包内重复"))).toBe(true);
    expect(errors.some((item) => item.includes("目标对象 Ghost 不存在"))).toBe(true);
    expect(errors.some((item) => item.includes("canonicalId press-07 重复"))).toBe(true);
  });
  it("rejects external ids mapped to two canonical identities", () => {
    const pkg = buildPublishablePackage();
    pkg.identityMappings = [
      { objectKey: "Device", canonicalId: "press-07", sources: [{ sourceKind: "dataset", sourceId: "ds-devices", externalId: "PRESS-07" }] },
      { objectKey: "MaintenanceEvent", canonicalId: "press-07-b", sources: [{ sourceKind: "dataset", sourceId: "ds-devices", externalId: "PRESS-07" }] },
    ];
    expect(validateOntologyPackageShape(pkg).some((item) => item.includes("外部身份"))).toBe(true);
  });
});

describe("ontology publish gate (nine gates, one test each)", () => {
  it("passes all nine gates on the publishable fixture", () => {
    const report = validateOntologyPublishGate(buildPublishablePackage(), publishableContext());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.gates.map((gate) => gate.gateId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("gate 1 fails when primary keys or properties are unconfirmed candidates", () => {
    const pkg = buildPublishablePackage();
    const device = pkg.objects[0]!;
    device.properties[0]!.confirmed = false;
    const report = validateOntologyPublishGate(pkg, publishableContext());
    const gate = report.gates.find((item) => item.gateId === 1)!;
    expect(gate.passed).toBe(false);
    expect(gate.errors.some((item) => item.includes("主键属性 device_id 尚未人工确认"))).toBe(true);
    expect(gate.errors.some((item) => item.includes("待确认候选"))).toBe(true);
  });

  it("gate 1 fails when an object has no source binding at all", () => {
    const pkg = buildPublishablePackage();
    pkg.objects[0]!.sourceBindings = [];
    expect(validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 1)!.errors.some((item) => item.includes("没有任何来源绑定"))).toBe(true);
  });

  it("gate 2 fails when relation endpoints vanish or evidence is missing", () => {
    const pkg = buildPublishablePackage();
    pkg.objects = pkg.objects.filter((object) => object.key !== "MaintenanceEvent");
    const report = validateOntologyPublishGate(pkg, publishableContext());
    const gate = report.gates.find((item) => item.gateId === 2)!;
    expect(gate.errors.some((item) => item.includes("目标对象 MaintenanceEvent 不存在"))).toBe(true);
  });

  it("gate 2 fails when a relation carries no evidence (no bare edges)", () => {
    const pkg = buildPublishablePackage();
    pkg.relations[0]!.evidence = [];
    expect(validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 2)!.errors.some((item) => item.includes("没有任何证据"))).toBe(true);
  });

  it("gate 3 is fail-closed when the capability catalog is unavailable", () => {
    const pkg = buildPublishablePackage();
    const report = validateOntologyPublishGate(pkg, {});
    const gate = report.gates.find((item) => item.gateId === 3)!;
    expect(gate.passed).toBe(false);
    expect(gate.errors[0]).toContain("fail-closed");
  });

  it("gate 3 fails on missing capability and version mismatch", () => {
    const pkg = buildPublishablePackage();
    pkg.actions[0]!.toolBinding.id = "ghost.capability";
    const missing = validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 3)!;
    expect(missing.errors.some((item) => item.includes("不在能力目录中"))).toBe(true);

    pkg.actions[0]!.toolBinding.id = "data.query.deviceDiagnosis";
    pkg.actions[0]!.toolBinding.version = "9.9.9";
    const mismatch = validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 3)!;
    expect(mismatch.errors.some((item) => item.includes("版本") && item.includes("不一致"))).toBe(true);
  });

  it("gate 3 checks the catalog only for capability bindings; mcp/api/workflow need explicit id+version", () => {
    const pkg = buildPublishablePackage();
    pkg.actions[0]!.toolBinding = { kind: "mcp", id: "external.diagnosis.tool", version: "2.0.0" };
    const gate = validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 3)!;
    expect(gate.passed).toBe(true);

    pkg.actions[0]!.toolBinding = { kind: "mcp", id: "", version: "" };
    const empty = validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 3)!;
    expect(empty.errors.some((item) => item.includes("缺少能力标识"))).toBe(true);
    expect(empty.errors.some((item) => item.includes("缺少版本"))).toBe(true);
  });

  it("gate 4 fails on malformed input/output schemas", () => {
    const pkg = buildPublishablePackage();
    pkg.actions[0]!.inputSchema = { type: "string" } as unknown as OntologyActionType["inputSchema"];
    pkg.actions[0]!.outputSchema = {} as OntologyActionType["outputSchema"];
    const gate = validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 4)!;
    expect(gate.errors.some((item) => item.includes("根类型必须是 object"))).toBe(true);
    expect(gate.errors.some((item) => item.includes("缺少 properties"))).toBe(true);
  });

  it("gate 5 forces approval, idempotency and rollback on high-risk actions", () => {
    const pkg = buildPublishablePackage();
    const risky: OntologyActionType = {
      ...pkg.actions[0]!,
      id: "a2",
      key: "adjust_sim_params",
      label: "调整仿真参数",
      effect: "control",
      riskLevel: "high",
      approvalRequired: false,
      idempotencyRequired: false,
      evidenceRequired: false,
    };
    delete risky.rollback;
    pkg.actions = [risky];
    const gate = validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 5)!;
    for (const fragment of ["未要求审批", "未要求幂等键", "缺少回滚说明", "写入/控制效果必须要求审批", "证据回执"]) {
      expect(gate.errors.some((item) => item.includes(fragment))).toBe(true);
    }
  });

  it("gate 6 fails when impact scope or authorized scopes are empty", () => {
    const pkg = buildPublishablePackage();
    pkg.actions[0]!.impactScope = [];
    pkg.actions[0]!.authorizedScopes = [];
    pkg.objects[0]!.owner = "";
    const gate = validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 6)!;
    expect(gate.errors.length).toBe(3);
  });

  it("gate 7 fails without golden questions or with failed replays", () => {
    const pkg = buildPublishablePackage();
    pkg.goldenQuestions = [];
    expect(validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 7)!.errors[0]).toContain("未登记任何黄金问题");

    pkg.goldenQuestions = [{ id: "q1", question: "口径问题", passed: false }];
    const gate = validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 7)!;
    expect(gate.errors[0]).toContain("未回放通过");
  });

  it("gate 8 is fail-closed on unknown fingerprints and drift without review", () => {
    const pkg = buildPublishablePackage();
    const missingCurrent = validateOntologyPublishGate(pkg, { ...publishableContext(), datasetSchemas: {} });
    expect(missingCurrent.gates.find((item) => item.gateId === 8)!.errors[0]).toContain("fail-closed");

    const drifted = validateOntologyPublishGate(pkg, { ...publishableContext(), datasetSchemas: { "ds-devices": "fp-devices-v2" } });
    expect(drifted.gates.find((item) => item.gateId === 8)!.errors[0]).toContain("已漂移且未人工复核");

    pkg.objects[0]!.sourceBindings[0]!.driftReviewed = true;
    expect(validateOntologyPublishGate(pkg, { ...publishableContext(), datasetSchemas: { "ds-devices": "fp-devices-v2" } }).gates.find((item) => item.gateId === 8)!.passed).toBe(true);
  });

  it("gate 9 fails when impact review is missing, unowned or policies absent for high risk", () => {
    const pkg = buildPublishablePackage();
    pkg.impactReviewed = false;
    expect(validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 9)!.errors).toEqual(["影响分析未完成（impactReviewed=false）"]);

    pkg.impactReviewed = true;
    pkg.impactReviewedBy = "";
    expect(validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 9)!.errors).toEqual(["影响分析缺少复核人"]);

    pkg.impactReviewedBy = "bob";
    pkg.actions[0]!.riskLevel = "high";
    expect(validateOntologyPublishGate(pkg, publishableContext()).gates.find((item) => item.gateId === 9)!.errors).toEqual(["包含高风险行动但未声明任何策略引用（policies 为空）"]);
  });

  it("labels all nine gates with the plan wording", () => {
    expect(Object.keys(ONTOLOGY_PUBLISH_GATE_LABELS)).toHaveLength(9);
    expect(ONTOLOGY_PUBLISH_GATE_LABELS[1]).toContain("主键");
    expect(ONTOLOGY_PUBLISH_GATE_LABELS[9]).toContain("影响分析");
  });
});

describe("ontology package fingerprint", () => {
  it("is stable under reordering and insensitive to status/version churn", () => {
    const pkg = buildPublishablePackage();
    const baseline = ontologyPackageFingerprint(pkg);
    pkg.objects.reverse();
    pkg.status = "published";
    pkg.version = 7;
    expect(ontologyPackageFingerprint(pkg)).toBe(baseline);

    pkg.objects[0]!.properties[0]!.label = "设备唯一编号";
    expect(ontologyPackageFingerprint(pkg)).not.toBe(baseline);
  });
});
