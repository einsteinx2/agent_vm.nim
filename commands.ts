// CLI subcommand handlers.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { confirm, destroyNamed, ensureRunning } from "./lifecycle.ts";
import {
  lima,
  limaInteractive,
  limaRunScript,
  limaSilent,
  printResources,
  resolveVm,
  vmExists,
  which,
} from "./lima.ts";
import { type AgentKind, SCRIPT_DIR, STATE_DIR, TEMPLATE, type VmOptions } from "./types.ts";

function rmSafetyCheck(name: string, hostDir: string, cwd: string, rm: boolean): boolean {
  if (!rm || hostDir === cwd) return true;
  console.error(
    `Error: --rm would destroy VM '${name}' mounted at ${hostDir}, which is shared with parent directories.`,
  );
  console.error(`Run --rm from ${hostDir}, or use --no-inherit to create a fresh VM for ${cwd}.`);
  return false;
}

export async function cmdSetup(opts: VmOptions, passthrough: string[]): Promise<number> {
  if (passthrough.includes("--help") || passthrough.includes("-h")) {
    console.log(`Usage: agent-vm setup [--disk GB] [--memory GB] [--cpus N]

Create a base VM template with dev tools and agents pre-installed.

Options:
  --disk GB      VM disk size (default: 10)
  --memory GB    VM memory (default: 2)
  --cpus N       Number of CPUs (default: 1)
  --help         Show this help`);
    return 0;
  }
  for (const a of passthrough) {
    // bash silently ignores unknown global-style flags that leaked here;
    // reject genuinely unknown setup args so typos fail loudly.
    if (
      a === "--reset" ||
      a === "--offline" ||
      a === "--readonly" ||
      a === "--git-read-only" ||
      a === "--git-ro" ||
      a === "--no-inherit" ||
      a === "--rm"
    ) {
      continue;
    }
    console.error(`Unknown option: ${a}`);
    console.error("Usage: agent-vm setup [--disk GB] [--memory GB] [--cpus N]");
    return 1;
  }

  const disk = opts.disk ?? "10";
  const memory = opts.memory ?? "2";
  const cpus = opts.cpus ?? "1";

  if (!which("limactl")) {
    const isMac = process.platform === "darwin";
    const hasBrew = which("brew") !== null;
    if (isMac && hasBrew) {
      console.error(
        "Lima is not installed. Install it with:\n\n  brew install lima\n\nThen re-run 'agent-vm setup'.",
      );
    } else if (isMac) {
      console.error(
        "Lima is not installed, and Homebrew was not found.\n\nInstall Homebrew first (see https://brew.sh), then run:\n\n  brew install lima\n\nThen re-run 'agent-vm setup'.",
      );
    } else {
      console.error(
        "Lima is not installed. Install it via your distro's package manager or follow https://lima-vm.io/docs/installation/\n\nThen re-run 'agent-vm setup'.",
      );
    }
    return 1;
  }

  await limaSilent(["stop", TEMPLATE]);
  await limaSilent(["delete", TEMPLATE, "--force"]);

  console.log("Creating base VM...");
  const createArgs = [
    "create",
    `--name=${TEMPLATE}`,
    "template:debian-13",
    "--set",
    ".mounts=[]",
    `--disk=${disk}`,
    `--memory=${memory}`,
    `--cpus=${cpus}`,
    "--tty=false",
  ];
  const createCode = await limaSilent(createArgs);
  if (createCode !== 0) {
    console.error("Error: Failed to create base VM.");
    return 1;
  }

  await printResources(TEMPLATE);

  const startCode = await limaSilent(["start", TEMPLATE]);
  if (startCode !== 0) {
    console.error("Error: Failed to start base VM.");
    return 1;
  }

  console.log("Installing packages inside VM...");
  const setupScript = join(SCRIPT_DIR, "agent-vm.setup.sh");
  const setupCode = await limaRunScript(TEMPLATE, "/", setupScript, "bash");
  if (setupCode !== 0) {
    console.error("Error: Setup script failed.");
    return 1;
  }

  const userSetup = join(STATE_DIR, "setup.sh");
  if (existsSync(userSetup)) {
    console.log(`Running custom setup from ${userSetup}...`);
    const code = await limaRunScript(TEMPLATE, "/", userSetup, "zsh");
    if (code !== 0) {
      console.error("Error: Custom setup script failed.");
      return 1;
    }
  }

  await limaSilent(["stop", TEMPLATE]);

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, ".agent-vm-base-version"), `${Math.floor(Date.now() / 1000)}\n`);

  console.log();
  console.log(
    "Base VM ready. Run 'agent-vm shell', 'agent-vm claude', 'agent-vm opencode', or 'agent-vm codex' in any project directory.",
  );
  console.log("Note: Existing VMs were not updated. Use --reset to re-clone them from the new base.");
  return 0;
}

export async function cmdAgent(kind: AgentKind, opts: VmOptions, passthrough: string[]): Promise<number> {
  const cwd = process.cwd();
  const { name, hostDir } = await resolveVm(cwd, opts.noInherit);
  if (!rmSafetyCheck(name, hostDir, cwd, opts.rm)) return 1;
  if (!(await ensureRunning(name, hostDir, opts))) return 1;
  await printResources(name);

  let innerCmd: string[];
  let tty = false;
  switch (kind) {
    case "claude":
      innerCmd = ["claude", "--dangerously-skip-permissions", ...passthrough];
      break;
    case "opencode":
      // TODO: add --dangerously-skip-permissions once released
      // (waiting on https://github.com/anomalyco/opencode/pull/11833)
      innerCmd = ["opencode", ...passthrough];
      tty = true;
      break;
    case "codex":
      innerCmd = ["codex", "--full-auto", ...passthrough];
      break;
  }

  const exitCode = await limaInteractive(name, cwd, innerCmd, { tty });
  if (opts.rm) {
    console.log("Removing VM...");
    console.log(`Stopping and deleting VM '${name}' (mounted at ${hostDir})...`);
    await destroyNamed(name);
    console.log("VM destroyed.");
  }
  return exitCode;
}

export async function cmdShell(opts: VmOptions): Promise<number> {
  const cwd = process.cwd();
  const { name, hostDir } = await resolveVm(cwd, opts.noInherit);
  if (!rmSafetyCheck(name, hostDir, cwd, opts.rm)) return 1;
  if (!(await ensureRunning(name, hostDir, opts))) return 1;
  await printResources(name);

  console.log(`VM: ${name} | Mount: ${hostDir} | Workdir: ${cwd}`);
  if (opts.rm) {
    console.log("Type 'exit' to leave. VM will be destroyed after exit.");
  } else {
    console.log("Type 'exit' to leave (VM keeps running). Use 'agent-vm stop' to stop it.");
  }

  const exitCode = await limaInteractive(name, cwd, ["zsh", "-l"]);
  if (opts.rm) {
    console.log("Removing VM...");
    console.log(`Stopping and deleting VM '${name}' (mounted at ${hostDir})...`);
    await destroyNamed(name);
    console.log("VM destroyed.");
  }
  return exitCode;
}

export async function cmdRun(opts: VmOptions, args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error("Usage: agent-vm run <command> [args]");
    return 1;
  }
  const cwd = process.cwd();
  const { name, hostDir } = await resolveVm(cwd, opts.noInherit);
  if (!rmSafetyCheck(name, hostDir, cwd, opts.rm)) return 1;
  if (!(await ensureRunning(name, hostDir, opts))) return 1;
  await printResources(name);

  const exitCode = await limaInteractive(name, cwd, args);
  if (opts.rm) {
    console.log("Removing VM...");
    console.log(`Stopping and deleting VM '${name}' (mounted at ${hostDir})...`);
    await destroyNamed(name);
    console.log("VM destroyed.");
  }
  return exitCode;
}

export async function cmdStop(opts: VmOptions): Promise<number> {
  const cwd = process.cwd();
  const { name, hostDir } = await resolveVm(cwd, opts.noInherit);
  if (!(await vmExists(name))) {
    console.error("No VM found for this directory.");
    return 1;
  }
  console.log(`Stopping VM '${name}' (mounted at ${hostDir})...`);
  await limaSilent(["stop", name]);
  console.log("VM stopped.");
  return 0;
}

export async function cmdDestroy(opts: VmOptions, passthrough: string[]): Promise<number> {
  const force = passthrough.includes("-y") || passthrough.includes("--yes");
  const cwd = process.cwd();
  const { name, hostDir } = await resolveVm(cwd, opts.noInherit);

  if (!(await vmExists(name))) {
    console.error("No VM found for this directory.");
    return 1;
  }

  if (hostDir !== cwd && !force) {
    console.log(`VM '${name}' is mounted at ${hostDir}, which is shared with parent directories.`);
    const ok = await confirm("Destroy it anyway? [y/N] ");
    if (!ok) {
      console.log("Aborted.");
      return 1;
    }
  }

  console.log(`Stopping and deleting VM '${name}' (mounted at ${hostDir})...`);
  await destroyNamed(name);
  console.log("VM destroyed.");
  return 0;
}

export async function cmdDestroyAll(): Promise<number> {
  const r = await lima(["list", "-q"]);
  const vms = r.stdout.split("\n").filter((n) => n.startsWith("avm-") || n.startsWith("agent-vm-"));
  if (vms.length === 0) {
    console.log("No agent-vm VMs found.");
    return 0;
  }
  console.log("This will destroy the following VMs:");
  for (const vm of vms) console.log(vm);
  const ok = await confirm("Continue? [y/N] ");
  if (!ok) {
    console.log("Aborted.");
    return 0;
  }
  for (const vm of vms) {
    console.log(`Destroying ${vm}...`);
    await destroyNamed(vm);
  }
  console.log("All VMs destroyed.");
  return 0;
}

export async function cmdList(): Promise<number> {
  const r = await lima(["list"]);
  if (r.exitCode !== 0) {
    process.stderr.write(r.stderr);
    return r.exitCode;
  }
  const lines = r.stdout.split("\n");
  if (lines.length === 0) return 0;
  console.log(lines[0]);
  const vms = lines.slice(1).filter((l) => /^(avm-|agent-vm-)/.test(l));
  if (vms.length === 0) {
    console.log("(no VMs)");
  } else {
    for (const vm of vms) console.log(vm);
  }
  return 0;
}

export async function cmdStatus(): Promise<number> {
  const cwd = process.cwd();
  const { name: resolvedName, hostDir: resolvedHostDir } = await resolveVm(cwd, false, true);
  let currentVmName = "";
  let currentHostDir = "";
  if (await vmExists(resolvedName)) {
    currentVmName = resolvedName;
    currentHostDir = resolvedHostDir;
  }

  const r = await lima(["list"]);
  if (r.exitCode !== 0) {
    process.stderr.write(r.stderr);
    return r.exitCode;
  }
  const lines = r.stdout.split("\n");
  const header = lines[0] ?? "";

  console.log(`VMs (current directory: ${cwd}):`);
  if (currentVmName && currentHostDir !== cwd) {
    console.log(`Inherited VM '${currentVmName}' (mounted at ${currentHostDir})`);
  }
  console.log();
  console.log(`  ${header}`);
  const vms = lines.slice(1).filter((l) => /^(avm-|agent-vm-)/.test(l));
  if (vms.length === 0) {
    console.log("  (no VMs)");
    return 0;
  }
  for (const line of vms) {
    const vmName = line.split(/\s+/)[0];
    console.log(vmName === currentVmName ? `> ${line}` : `  ${line}`);
  }
  return 0;
}

export function cmdHelp(): void {
  console.log(`Usage: agent-vm [options] <command> [args]

Commands:
  setup              Create the base VM template (run once)
  claude [args]      Run Claude Code in the VM for the current directory
  opencode [args]    Run OpenCode in the VM for the current directory
  codex [args]       Run Codex CLI in the VM for the current directory
  shell              Open a shell in the VM for the current directory
  run <cmd> [args]   Run a command in the VM for the current directory
  stop               Stop the VM for the current directory
  rm                 Stop and delete the VM for the current directory
  destroy-all        Stop and delete all agent-vm VMs
  list               List all agent-vm VMs
  status             Show status of all VMs (current dir marked with >)
  help               Show this help

VM options (for claude, opencode, codex, shell, run):
  --disk GB          VM disk size (default: 10)
  --memory GB        VM memory (default: 2)
  --cpus N           Number of CPUs (default: 1)
  --reset            Destroy and re-clone the VM from the base template
  --offline          Block outbound internet (keeps host/VM communication)
  --readonly         Mount the project directory as read-only
  --git-read-only    Mount .git directory as read-only (allows git diff/log but not commit/stash)
  --rm               Automatically destroy the VM after the command exits
  --no-inherit       Create a new VM for cwd instead of reusing an ancestor's VM

Examples:
  agent-vm setup                             # Create base VM
  agent-vm claude                            # Run Claude in a VM
  agent-vm opencode                          # Run OpenCode in a VM
  agent-vm codex                             # Run Codex in a VM
  agent-vm --disk 50 --memory 16 --cpus 8 claude  # Custom resources
  agent-vm --reset claude                    # Fresh VM from base template
  agent-vm --rm claude                       # Destroy VM after Claude exits
  agent-vm --offline claude                  # No internet access
  agent-vm --readonly shell                  # Read-only project mount
  agent-vm --git-ro claude                   # Protect .git from writes
  agent-vm shell                             # Shell into the VM
  agent-vm run npm install                   # Run a command in the VM
  agent-vm claude -p "fix lint errors"       # Pass args to claude

VMs are persistent and unique per directory. Running "agent-vm shell" or
"agent-vm claude" in the same directory will reuse the same VM. Running
from a subdirectory reuses the nearest ancestor's VM (use --no-inherit to
force a new VM scoped to cwd).

Customization:
  ~/.agent-vm/setup.sh              Per-user setup (runs during "agent-vm setup")
  ~/.agent-vm/runtime.sh            Per-user runtime (runs on each VM start)
  <project>/.agent-vm.runtime.sh    Per-project runtime (runs on each VM start)

More info: https://github.com/einsteinx2/agent-vm`);
}
