import { describe, expect, it, vi } from "vitest";
import { createDashboardPublicationApi } from "./dashboardPublicationApi";

describe("dashboard client branding transport", () => {
  it.each(["exe", "zip"] as const)("POSTs branding only for %s and retains cancellation", async format => {
    const open = vi.fn().mockResolvedValue(new Response());
    const api = createDashboardPublicationApi(vi.fn(), open), signal = new AbortController().signal;
    const branding = { applicationName: "热电园区", iconDataUrl: "data:image/png;base64,YQ==" };
    await api.openDashboardCandidateDownload("p", "a", "c", format, signal, branding);
    expect(open.mock.calls[0]![1]).toEqual({ method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ branding }) });
  });
  it.each(["exe", "zip", "web", "dmda", "apk"] as const)("keeps default %s as GET", async format => {
    const open = vi.fn().mockResolvedValue(new Response()), api = createDashboardPublicationApi(vi.fn(), open);
    await api.openDashboardCandidateDownload("p", "a", "c", format);
    expect(open.mock.calls[0]![1]).toEqual({});
  });
  it("POSTs Android signing for apk downloads and keeps branding out of the body", async () => {
    const open = vi.fn().mockResolvedValue(new Response());
    const api = createDashboardPublicationApi(vi.fn(), open), signal = new AbortController().signal;
    const signing = { keystoreBase64: "BwgJCQ==", storePassword: "s3cret", keyAlias: "release" };
    await api.openDashboardCandidateDownload("p", "a", "c", "apk", signal, undefined, signing);
    expect(open.mock.calls[0]![1]).toEqual({ method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ signing }) });
  });
  it.each(["web", "dmda"] as const)("does not send Windows branding to %s", async format => {
    const open = vi.fn().mockResolvedValue(new Response()), api = createDashboardPublicationApi(vi.fn(), open);
    await api.openDashboardCandidateDownload("p", "a", "c", format, undefined, { applicationName: "Ignored" });
    expect(open.mock.calls[0]![1]).toEqual({});
  });
});
