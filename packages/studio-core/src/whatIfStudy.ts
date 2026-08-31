import type {
  WhatIfOperatingEnvelopeInput,
  WhatIfOperatingEnvelopeResult,
} from "./whatIfOperatingEnvelope.js";

export interface WhatIfStudyRequest {
  name: string;
  input: WhatIfOperatingEnvelopeInput;
}

/** 服务端保存输入、结果与执行证据，页面不得仅凭当前表单宣称可复现。 */
export interface WhatIfStudyRecord extends WhatIfStudyRequest {
  id: string;
  projectId: string;
  createdAt: string;
  reproductionOf?: string;
  result: WhatIfOperatingEnvelopeResult;
  execution?: {
    engineId: "deterministic-local-elasticity-envelope";
    engineVersion: "1.0.0";
    inputFingerprint: string;
    deterministic: true;
  };
}
