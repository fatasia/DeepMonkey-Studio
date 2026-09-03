import type { ScriptModule } from "@bim-studio/contracts";

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
