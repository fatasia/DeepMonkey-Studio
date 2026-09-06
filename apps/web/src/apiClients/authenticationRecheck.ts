interface AuthenticationHost {
  getAccessToken(): string | undefined | Promise<string | undefined>;
  getServerProfile(): { baseUrl: string } | Promise<{ baseUrl: string }>;
  notifyUnauthorized(): void;
}

/** 只编排身份复核；HTTP 能力由 api.ts 注入，不持有浏览器网络或凭据存储。 */
export function createAuthenticationRecheck(host: AuthenticationHost, transport: typeof fetch): () => void {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return;
    pending = Promise.resolve().then(async () => {
      try {
        // 凭据适配器也可能暂时失败；不能让后台复核抛出未处理拒绝或代替业务请求登出。
        const resolvedToken = await host.getAccessToken();
        if (!resolvedToken) return;
        const { baseUrl } = await host.getServerProfile();
        const response = await transport(new URL("/api/auth/me", baseUrl), {
          headers: { authorization: `Bearer ${resolvedToken}` },
          cache: "no-store",
        });
        if (response.status === 401 && (await host.getAccessToken()) === resolvedToken) host.notifyUnauthorized();
      } catch {
        // 无法复核时保持登录；下一次真实请求仍会重新验证。
      }
    }).finally(() => { pending = undefined; });
  };
}
