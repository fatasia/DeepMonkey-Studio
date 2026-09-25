import { describe, expect, it, vi } from "vitest";
import type { CameraState } from "@bim-studio/contracts";
import { createCameraInfoPublisher } from "./cameraInfoPublisher";

describe("createCameraInfoPublisher", () => {
  it("publishes the first state immediately and coalesces burst updates to the latest state", () => {
    let now = 0;
    const queued: Array<() => void> = [];
    const publish = vi.fn();
    const publisher = createCameraInfoPublisher(publish, 50, {
      now: () => now,
      schedule: callback => { queued.push(callback); return 1 as never; },
      cancel: vi.fn(),
    });
    publisher.push(camera(1));
    now = 10; publisher.push(camera(2));
    now = 20; publisher.push(camera(3));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(1);
    now = 50; queued[0]!();
    expect(publish).toHaveBeenLastCalledWith(camera(3));
  });

  it("cancels a pending trailing update on disposal", () => {
    let now = 0;
    const publish = vi.fn(), cancel = vi.fn();
    const publisher = createCameraInfoPublisher(publish, 50, {
      now: () => now,
      schedule: () => 7 as never,
      cancel,
    });
    publisher.push(camera(1));
    now = 10; publisher.push(camera(2));
    publisher.dispose();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

function camera(x: number): CameraState {
  return { position: { x, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit", avatarVisible: false };
}
