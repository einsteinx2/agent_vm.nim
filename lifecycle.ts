// VM lifecycle: startup, teardown, and the interactive confirm prompt.

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { lima, limaRunScript, limaSilent, printResources, vmExists, vmRunning } from "./lima.ts";
import { allocateSlot, getSlot, hostIpFor, releaseSlot } from "./ports.ts";
import { DRY_RUN, STATE_DIR, TEMPLATE, type VmOptions } from "./types.ts";

const execFileP = promisify(execFile);

export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    return /^[Yy]/.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function setPortForwards(vmName: string, slot: number): Promise<number> {
  const hostIP = hostIpFor(slot);
  // Guest 0.0.0.0 matches any bound interface (including 127.0.0.1), per
  // Lima's "0.0.0.0 matches any bound interface" semantics. Range starts at
  // 1024 to avoid fighting Lima's ssh forward on port 22.
  const forwards = [
    {
      guestIP: "0.0.0.0",
      guestPortRange: [1024, 65535],
      hostIP,
      hostPortRange: [1024, 65535],
    },
  ];
  return limaSilent(["edit", vmName, "--set", `.portForwards = ${JSON.stringify(forwards)}`], { cwd: "/tmp" });
}

// On macOS, 127.0.0.X (X > 1) is not aliased to lo0 by default. Add the alias
// if missing. On Linux, all of 127.0.0.0/8 is loopback — no-op.
async function ensureLoopbackAlias(slot: number): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const hostIP = hostIpFor(slot);
  if (DRY_RUN) {
    console.error(`[dry-run] ensure lo0 alias ${hostIP}`);
    return true;
  }
  try {
    const { stdout } = await execFileP("ifconfig", ["lo0"]);
    if (stdout.includes(`inet ${hostIP} `)) return true;
  } catch {}
  console.log(`Adding loopback alias ${hostIP} (one-time, requires sudo)...`);
  const code = await new Promise<number>((resolve) => {
    const proc = spawn("sudo", ["ifconfig", "lo0", "alias", hostIP, "up"], { stdio: "inherit" });
    proc.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    console.error(
      `Error: failed to add loopback alias ${hostIP}.\n` +
        `Run this manually and retry:\n\n  sudo ifconfig lo0 alias ${hostIP} up\n`,
    );
    return false;
  }
  return true;
}

export async function ensureRunning(vmName: string, hostDir: string, opts: VmOptions): Promise<boolean> {
  if (!(await vmExists(TEMPLATE))) {
    console.error("Error: Base VM not found. Run 'agent-vm setup' first.");
    return false;
  }

  if (opts.reset && (await vmExists(vmName))) {
    console.log(`Resetting VM '${vmName}'...`);
    await limaSilent(["stop", vmName]);
    await limaSilent(["delete", vmName, "--force"]);
    try {
      unlinkSync(join(STATE_DIR, `.agent-vm-version-${vmName}`));
    } catch {}
    // Keep the slot file — same VM name gets the same host IP after reset.
  }

  const exists = await vmExists(vmName);
  if (!exists) {
    console.log(`Creating VM '${vmName}'...`);
    await limaSilent(["clone", TEMPLATE, vmName, "--tty=false"]);

    const slot = allocateSlot(vmName);
    const mountJson = JSON.stringify([{ location: hostDir, writable: true }]);
    const editArgs = ["edit", vmName, "--set", `.mounts = ${mountJson}`];
    if (opts.memory) editArgs.push("--memory", opts.memory);
    if (opts.cpus) editArgs.push("--cpus", opts.cpus);
    await limaSilent(editArgs, { cwd: "/tmp" });
    await setPortForwards(vmName, slot);

    if (opts.disk) {
      const code = await limaSilent(["edit", vmName, "--disk", opts.disk], { cwd: "/tmp" });
      if (code !== 0) {
        console.error(
          `Warning: Cannot set disk to ${opts.disk} GiB (shrinking is not supported). Re-run 'agent-vm setup --disk ${opts.disk}' for a smaller base.`,
        );
      }
    }

    await printResources(vmName);

    const baseVer = join(STATE_DIR, ".agent-vm-base-version");
    if (existsSync(baseVer)) {
      writeFileSync(join(STATE_DIR, `.agent-vm-version-${vmName}`), readFileSync(baseVer));
    }
  } else if (opts.disk || opts.memory || opts.cpus) {
    if (await vmRunning(vmName)) {
      console.log(`VM '${vmName}' is currently running. It must be stopped to apply new resource settings.`);
      const ok = await confirm("Stop the VM and apply changes? [y/N] ");
      if (!ok) {
        console.log("Aborted. Starting with current settings.");
        return true;
      }
      console.log("Stopping VM...");
      await limaSilent(["stop", vmName]);
    }
    console.log("Updating VM resources...");
    const mountJson = JSON.stringify([{ location: hostDir, writable: true }]);
    const editArgs = ["edit", vmName, "--set", `.mounts = ${mountJson}`];
    if (opts.memory) editArgs.push("--memory", opts.memory);
    if (opts.cpus) editArgs.push("--cpus", opts.cpus);
    const r = await lima(editArgs, { cwd: "/tmp" });
    if (r.exitCode !== 0) {
      console.error("Error: Failed to update VM resources:");
      process.stderr.write(r.stderr);
      return false;
    }
    if (opts.disk) {
      const code = await limaSilent(["edit", vmName, "--disk", opts.disk], { cwd: "/tmp" });
      if (code !== 0) {
        console.error(
          `Warning: Cannot set disk to ${opts.disk} GiB (shrinking is not supported). Re-run 'agent-vm setup --disk ${opts.disk}' for a smaller base.`,
        );
      }
    }
    await printResources(vmName);
  }

  // Back-fill port forwarding for VMs created before this feature.
  if (exists && getSlot(vmName) === null) {
    console.log(
      `VM '${vmName}' predates per-VM port forwarding. Configuring a dedicated host loopback IP (one-time)...`,
    );
    if (await vmRunning(vmName)) {
      console.log("Stopping VM to apply port-forwarding config...");
      await limaSilent(["stop", vmName]);
    }
    const slot = allocateSlot(vmName);
    await setPortForwards(vmName, slot);
  }

  const baseVer = join(STATE_DIR, ".agent-vm-base-version");
  const vmVer = join(STATE_DIR, `.agent-vm-version-${vmName}`);
  if (existsSync(baseVer)) {
    const baseContent = readFileSync(baseVer, "utf8").trim();
    const vmContent = existsSync(vmVer) ? readFileSync(vmVer, "utf8").trim() : "";
    if (baseContent !== vmContent) {
      console.error(
        "Warning: Base VM has been updated since this VM was cloned. Use --reset to re-clone from the new base.",
      );
    }
  }

  const slot = getSlot(vmName);
  if (slot !== null && !(await ensureLoopbackAlias(slot))) return false;

  if (!(await vmRunning(vmName))) {
    console.log(`Starting VM '${vmName}'...`);
    await limaSilent(["start", vmName]);
  }

  if (slot !== null) {
    const hostIP = hostIpFor(slot);
    console.log(`Host IP: ${hostIP}  (all guest ports forwarded here)`);
    console.log("Use 'agent-vm ports' to list services currently listening in this VM.");
  }

  const userRuntime = join(STATE_DIR, "runtime.sh");
  if (existsSync(userRuntime)) {
    console.log("Running user runtime setup...");
    await limaRunScript(vmName, hostDir, userRuntime, "zsh");
  }
  const projectRuntime = join(hostDir, ".agent-vm.runtime.sh");
  if (existsSync(projectRuntime)) {
    console.log("Running project runtime setup...");
    await limaRunScript(vmName, hostDir, projectRuntime, "zsh");
  }

  if (opts.offline) {
    console.log("Enabling offline mode...");
    await limaSilent(["shell", vmName, "sudo", "iptables", "-F", "OUTPUT"]);
    await limaSilent(["shell", vmName, "sudo", "iptables", "-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"]);
    await limaSilent(["shell", vmName, "sudo", "iptables", "-A", "OUTPUT", "-d", "10.0.0.0/8", "-j", "ACCEPT"]);
    await limaSilent(["shell", vmName, "sudo", "iptables", "-A", "OUTPUT", "-d", "172.16.0.0/12", "-j", "ACCEPT"]);
    await limaSilent(["shell", vmName, "sudo", "iptables", "-A", "OUTPUT", "-d", "192.168.0.0/16", "-j", "ACCEPT"]);
    await limaSilent(["shell", vmName, "sudo", "iptables", "-P", "OUTPUT", "DROP"]);
  }

  if (opts.readonly) {
    console.log("Mounting project directory as read-only...");
    await limaSilent(["shell", vmName, "sudo", "mount", "-o", "remount,ro", hostDir]);
  }

  if (opts.gitRo && existsSync(join(hostDir, ".git"))) {
    console.log("Mounting .git directory as read-only...");
    const gitPath = join(hostDir, ".git");
    await limaSilent(["shell", vmName, "sudo", "mount", "--bind", gitPath, gitPath]);
    await limaSilent(["shell", vmName, "sudo", "mount", "-o", "remount,ro,bind", gitPath]);
  }

  return true;
}

export async function destroyNamed(name: string): Promise<void> {
  await limaSilent(["stop", name]);
  await limaSilent(["delete", name, "--force"]);
  try {
    unlinkSync(join(STATE_DIR, `.agent-vm-version-${name}`));
  } catch {}
  releaseSlot(name);
}
