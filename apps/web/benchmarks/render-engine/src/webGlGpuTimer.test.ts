import { describe, expect, it, vi } from "vitest";
import { WebGlGpuTimer } from "./webGlGpuTimer";

describe("WebGL GPU timer", () => {
  it("converts asynchronous nanosecond query results to milliseconds", () => {
    const query = {} as WebGLQuery;
    const gl = {
      QUERY_RESULT_AVAILABLE: 1,
      QUERY_RESULT: 2,
      getExtension: () => ({ TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 }),
      getParameter: () => false,
      createQuery: () => query,
      beginQuery: vi.fn(),
      endQuery: vi.fn(),
      getQueryParameter: (_query: WebGLQuery, field: number) => field === 1 ? true : 2_000_000,
      deleteQuery: vi.fn()
    } as unknown as WebGL2RenderingContext;
    const timer = new WebGlGpuTimer(gl);

    timer.begin();
    timer.end();

    expect(timer.snapshot()).toMatchObject({ samples: 1, p50Ms: 2, p95Ms: 2 });
    expect(gl.beginQuery).toHaveBeenCalledWith(3, query);
    expect(gl.deleteQuery).toHaveBeenCalledWith(query);
  });
});
