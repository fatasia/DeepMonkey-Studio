/** GPU owners remain bound to the device that created their pipelines and layouts. */
export class RendererDeviceEpoch {
  constructor(private readonly createdDevice: object) {}
  assertCurrent(device: object): void {
    if (device !== this.createdDevice) {
      throw new Error("GPU device changed; create a complete renderer before submitting GPU work.");
    }
  }
}
