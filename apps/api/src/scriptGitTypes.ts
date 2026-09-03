import type { ScriptModule } from "@bim-studio/contracts";

export type ScriptGitErrorCode =
  | "GIT_UNAVAILABLE"
  | "GIT_TIMEOUT"
  | "GIT_VALIDATION_FAILED"
  | "GIT_REMOTE_REQUIRED"
  | "GIT_REMOTE_REJECTED"
  | "GIT_DIVERGED"
  | "GIT_DIRTY"
  | "GIT_OPERATION_FAILED";

export class ScriptGitError extends Error {
  constructor(
    readonly code: ScriptGitErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ScriptGitError";
  }
}

export interface ScriptGitChange {
  status: string;
  path: string;
}

export type ScriptGitRemoteState =
  | { configured: false; message: string }
  | { configured: true; url: string; branch: string };

export interface ScriptGitStatus {
  initialized: boolean;
  branch: string;
  clean: boolean;
  changes: ScriptGitChange[];
  ahead: number;
  behind: number;
  remote: ScriptGitRemoteState;
}

export interface ScriptGitCommit {
  hash: string;
  shortHash: string;
  author: string;
  committedAt: string;
  message: string;
}

export interface ScriptGitCommitResult {
  committed: boolean;
  commit?: ScriptGitCommit;
  status: ScriptGitStatus;
}

export interface ScriptGitPullResult {
  updated: boolean;
  scripts: ScriptModule[];
  status: ScriptGitStatus;
}

export interface ScriptGitPushResult {
  pushed: boolean;
  status: ScriptGitStatus;
}

export interface ScriptGitServiceContract {
  status(projectId: string): Promise<ScriptGitStatus>;
  history(projectId: string, limit?: number): Promise<ScriptGitCommit[]>;
  syncAndCommit(projectId: string, scripts: readonly ScriptModule[], message: string): Promise<ScriptGitCommitResult>;
  configureRemote(projectId: string, url: string, branch: string): Promise<ScriptGitStatus>;
  removeRemote(projectId: string): Promise<ScriptGitStatus>;
  pull(projectId: string): Promise<ScriptGitPullResult>;
  push(projectId: string): Promise<ScriptGitPushResult>;
}

export interface ScriptGitManifest {
  schemaVersion: 1;
  scripts: ScriptGitManifestEntry[];
}

export interface ScriptGitManifestEntry extends Omit<ScriptModule, "code"> {
  file: string;
}
