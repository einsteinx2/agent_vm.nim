// VM lifecycle: startup, teardown, and the interactive confirm prompt.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { lima, limaRunScript, limaSilent, printResources, vmExists, vmRunning } from "./lima.ts";
import { STATE_DIR, TEMPLATE, type VmOptions } from "./types.ts";

export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    return /^[Yy]/.test(answer.trim());
  } finally {
    rl.close();
  }
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
  }

  const exists = await vmExists(vmName);
  if (!exists) {
    console.log(`Creating VM '${vmName}'...`);
    await limaSilent(["clone", TEMPLATE, vmName, "--tty=false"]);

    const mountJson = JSON.stringify([{ location: hostDir, writable: true }]);
    const editArgs = ["edit", vmName, "--set", `.mounts = ${mountJson}`];
    if (opts.memory) editArgs.push("--memory", opts.memory);
    if (opts.cpus) editArgs.push("--cpus", opts.cpus);
    await limaSilent(editArgs, { cwd: "/tmp" });

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

  if (!(await vmRunning(vmName))) {
    console.log(`Starting VM '${vmName}'...`);
    await limaSilent(["start", vmName]);
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
}
