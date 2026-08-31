declare module "net-snmp" {
  export const Version2c: number;

  export interface Varbind {
    oid: string;
    type: number;
    value: unknown;
  }

  export interface Session {
    get(oids: string[], callback: (error: Error | null, values?: Varbind[]) => void): void;
    close(): void;
  }

  export function createSession(target: string, community: string, options?: { port?: number; timeout?: number; retries?: number; version?: number }): Session;
  export function isVarbindError(value: Varbind): boolean;
  export function varbindError(value: Varbind): string;
}
