import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedOpcUaClient, ensureClientCertificate, type OpcUaMessageSecurityMode } from "./opcUaSecureTransport.js";
import { resolveOpcUaSecurity } from "./opcUaSubscriptionSource.js";
import { CertificateManager } from "node-opcua-pki";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

describe("OPC UA security mode fidelity", () => {
  it.each(["signAndEncrypt", "SIGNANDENCRYPT", " signAndEncrypt "])("normalizes %s to the canonical encrypted mode", (securityMode) => {
    expect(resolveOpcUaSecurity({ certificateManagerRootDir: "pki", securityMode })).toEqual({
      certificateManagerRootDir: path.normalize("pki"), messageSecurityMode: "signAndEncrypt",
    });
  });

  it("keeps absent security and the legacy signing default unchanged", () => {
    expect(resolveOpcUaSecurity({})).toBeUndefined();
    expect(resolveOpcUaSecurity({ certificateManagerRootDir: " pki ", applicationName: " client " })).toEqual({
      certificateManagerRootDir: path.normalize("pki"), applicationName: "client",
    });
    expect(resolveOpcUaSecurity({ certificateManagerRootDir: "pki", securityMode: " SIGN " })?.messageSecurityMode).toBe("sign");
  });

  it.each(["signAndEncrypt", "sign", "none", "", 2, false])("rejects an explicit mode %s without a certificate directory", (securityMode) => {
    expect(() => resolveOpcUaSecurity({ securityMode })).toThrow(/certificateManagerRootDir/);
  });

  it.each(["none", "encrypt", "", "   ", 3, false])("rejects unsupported mode %s before connecting", (securityMode) => {
    expect(() => resolveOpcUaSecurity({ certificateManagerRootDir: "pki", securityMode })).toThrow(/securityMode/);
  });

  it.each(["signandencrypt", "", null, false, 2])("rejects runtime-invalid transport mode %s before certificate IO", async (messageSecurityMode) => {
    const initialize = vi.spyOn(CertificateManager.prototype, "initialize");
    await expect(createSignedOpcUaClient({
      endpointUrl: "opc.tcp://127.0.0.1:1", certificateManagerRootDir: "must-not-be-created",
      messageSecurityMode: messageSecurityMode as OpcUaMessageSecurityMode,
    })).rejects.toThrow(/messageSecurityMode/);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("reuses certificate bytes and releases each short-lived manager", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opcua-fidelity-cert-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const dispose = vi.spyOn(CertificateManager.prototype, "dispose");
    const options = { endpointUrl: "opc.tcp://127.0.0.1:1", certificateManagerRootDir: root, applicationName: "fidelity-client" };
    const first = await ensureClientCertificate(options);
    const bytes = await readFile(first.certificateFile);
    const second = await ensureClientCertificate(options);
    expect(second).toEqual(first);
    expect(await readFile(second.certificateFile)).toEqual(bytes);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("releases the manager when certificate initialization fails", async () => {
    vi.spyOn(CertificateManager.prototype, "initialize").mockRejectedValueOnce(new Error("certificate storage unavailable"));
    const dispose = vi.spyOn(CertificateManager.prototype, "dispose");
    await expect(ensureClientCertificate({ endpointUrl: "opc.tcp://127.0.0.1:1", certificateManagerRootDir: "unused" })).rejects.toThrow("certificate storage unavailable");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
