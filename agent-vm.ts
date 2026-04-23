#!/usr/bin/env -S node --experimental-strip-types
// agent-vm: Run AI coding agents inside sandboxed Lima VMs
// Part of https://github.com/einsteinx2/agent-vm

import { parseGlobals, parseSubArgs } from "./cli.ts";
import {
  cmdAgent,
  cmdDestroy,
  cmdDestroyAll,
  cmdHelp,
  cmdList,
  cmdPorts,
  cmdRun,
  cmdSetup,
  cmdShell,
  cmdStatus,
  cmdStop,
} from "./commands.ts";
import { DRY_RUN, mergeOpts } from "./types.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { opts: globalOpts, command, rest } = parseGlobals(argv);
  const { opts: subOpts, passthrough } = parseSubArgs(rest);
  const opts = mergeOpts(subOpts, globalOpts);

  if (DRY_RUN) {
    console.error(
      `[dry-run] parsed: command=${command} opts=${JSON.stringify(opts)} passthrough=${JSON.stringify(passthrough)}`,
    );
  }

  switch (command) {
    case "setup":
      return cmdSetup(opts, passthrough);
    case "claude":
      return cmdAgent("claude", opts, passthrough);
    case "opencode":
      return cmdAgent("opencode", opts, passthrough);
    case "codex":
      return cmdAgent("codex", opts, passthrough);
    case "shell":
      return cmdShell(opts);
    case "run":
      return cmdRun(opts, passthrough);
    case "stop":
      return cmdStop(opts);
    case "rm":
    case "destroy":
      return cmdDestroy(opts, passthrough);
    case "destroy-all":
      return cmdDestroyAll();
    case "list":
      return cmdList();
    case "status":
      return cmdStatus();
    case "ports":
      return cmdPorts(opts);
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'agent-vm help' for usage.");
      return 1;
  }
}

process.exit(await main());
