import { describe, expect, it } from "vitest";
import { extractWebRtcInternalsHardwareEvidence, firstNonEmpty, isExplicitSoftwareEncoderStats, isHardwareEncoderStats } from "./chromiumRuntime.js";

describe("Chromium hardware evidence", () => {
  it("falls back from an empty vendorString to driverVendor", () => {
    expect(firstNonEmpty("", "NVIDIA", "unknown")).toBe("NVIDIA");
  });

  it("accepts explicit runtime hardware proof and rejects known software encoders", () => {
    expect(isHardwareEncoderStats("NVIDIA NVENC", undefined)).toBe(false);
    expect(isHardwareEncoderStats("ExternalEncoder", true)).toBe(true);
    expect(isHardwareEncoderStats("libvpx", true)).toBe(false);
    expect(isHardwareEncoderStats("ExternalEncoder", undefined)).toBe(false);
    expect(isExplicitSoftwareEncoderStats(undefined, undefined)).toBe(false);
    expect(isExplicitSoftwareEncoderStats("OpenH264", undefined)).toBe(true);
    expect(isExplicitSoftwareEncoderStats("ExternalEncoder", false)).toBe(true);
  });

  it("extracts the latest encoder proof from chrome webrtc-internals text", () => {
    expect(extractWebRtcInternalsHardwareEvidence("encoderImplementation\nlibvpx\npowerEfficientEncoder\nfalse\nencoderImplementation\nMediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)\npowerEfficientEncoder\ntrue")).toEqual({
      encoderImplementation: "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)",
      powerEfficientEncoder: true
    });
  });

  it("separates comma-delimited encoderImplementation and power evidence", () => {
    expect(extractWebRtcInternalsHardwareEvidence("outbound-rtp (kind=video, mid=0, ssrc=42), encoderImplementation=MediaFoundationVideoEncodeAccelerator (NVIDIA HEVC Encoder MFT), powerEfficientEncoder=true, [codec]=H265, framesEncoded=93, packetsSent=188")).toEqual({
      encoderImplementation: "MediaFoundationVideoEncodeAccelerator (NVIDIA HEVC Encoder MFT)",
      powerEfficientEncoder: true
    });
  });
});
