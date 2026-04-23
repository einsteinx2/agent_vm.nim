// Shared types, constants, and option helpers.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE = "avm-base";
export const STATE_DIR = join(homedir(), ".agent-vm");
export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DRY_RUN = process.env.AGENT_VM_DRY_RUN === "1";

export type VmOptions = {
  disk?: string;
  memory?: string;
  cpus?: string;
  reset: boolean;
  offline: boolean;
  readonly: boolean;
  gitRo: boolean;
  rm: boolean;
  noInherit: boolean;
};

export type ResolvedVm = { name: string; hostDir: string };
export type AgentKind = "claude" | "opencode" | "codex";

export function emptyOpts(): VmOptions {
  return {
    reset: false,
    offline: false,
    readonly: false,
    gitRo: false,
    rm: false,
    noInherit: false,
  };
}

export function mergeOpts(primary: VmOptions, fallback: VmOptions): VmOptions {
  return {
    disk: primary.disk ?? fallback.disk,
    memory: primary.memory ?? fallback.memory,
    cpus: primary.cpus ?? fallback.cpus,
    reset: primary.reset || fallback.reset,
    offline: primary.offline || fallback.offline,
    readonly: primary.readonly || fallback.readonly,
    gitRo: primary.gitRo || fallback.gitRo,
    rm: primary.rm || fallback.rm,
    noInherit: primary.noInherit || fallback.noInherit,
  };
}
