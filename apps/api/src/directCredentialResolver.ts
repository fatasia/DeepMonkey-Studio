import type { DirectCredentialResolver, ResolvedDirectCredential } from "./connectorGateway.js";

/** 小型部署可直接注入只读凭据表；绑定文档始终只保存引用，不保存密钥。 */
export class StaticDirectCredentialResolver implements DirectCredentialResolver {
  constructor(private readonly credentials: Readonly<Record<string, Readonly<Record<string, string>>>>) {}

  async resolve(credentialRef: string): Promise<ResolvedDirectCredential | undefined> {
    const headers = Object.prototype.hasOwnProperty.call(this.credentials, credentialRef) ? this.credentials[credentialRef] : undefined;
    return headers ? { headers: { ...headers } } : undefined;
  }
}
