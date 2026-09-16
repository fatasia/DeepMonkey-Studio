/** Observes the production indirect buffers; does not generate substitute commands. */
export function observeMeshletCommands(device: GPUDevice) {
  const buffers = new Set<GPUBuffer>(), create = device.createBuffer;
  device.createBuffer = function(descriptor: GPUBufferDescriptor) {
    const buffer = create.call(device, descriptor);
    if (descriptor.label === "Deep meshlet indirect commands") {
      buffers.add(buffer); const destroy = buffer.destroy.bind(buffer);
      buffer.destroy = () => { buffers.delete(buffer); destroy(); };
    }
    return buffer;
  };
  return {
    restore() { device.createBuffer = create; },
    async read(): Promise<number[]> {
      const counts: number[] = [];
      for (const buffer of buffers) {
        const read = create.call(device, { size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, read, 0, buffer.size);
          device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
          const commands = new Uint32Array(read.getMappedRange()); let visible = 0;
          for (let command = 0; command < commands.length; command += 5) if (commands[command]! && commands[command + 1]!) visible++;
          counts.push(visible); read.unmap();
        } finally { read.destroy(); }
      }
      return counts;
    },
  };
}
