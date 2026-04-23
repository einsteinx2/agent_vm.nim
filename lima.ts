// limactl wrappers and VM state queries.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename, dirname } from "node:path";

import { DRY_RUN, type ResolvedVm } from "./types.ts";

type LimaResult = { exitCode: number; stdout: string; stderr: string };

export function which(cmd: string): string | null {
  const paths = (process.env.PATH ?? "").split(":");
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? "").split(";") : [""];
  for (const dir of paths) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = `${dir}/${cmd}${ext}`;
      try {
        if (statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding("utf8");
  let buf = "";
  for await (const chunk of stream) buf += chunk;
  return buf;
}

export async function lima(args: string[], opts: { cwd?: string } = {}): Promise<LimaResult> {
  if (DRY_RUN) {
    const cmd = ["limactl", ...args].join(" ");
    console.error(opts.cwd ? `[dry-run] (cd ${opts.cwd} && ${cmd})` : `[dry-run] ${cmd}`);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  const proc = spawn("limactl", args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readAll(proc.stdout!),
    readAll(proc.stderr!),
    new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 0))),
  ]);
  return { exitCode, stdout, stderr };
}

// Fire-and-forget limactl with output suppressed (matches bash `&>/dev/null`).
export async function limaSilent(args: string[], opts: { cwd?: string } = {}): Promise<number> {
  const r = await lima(args, opts);
  return r.exitCode;
}

// Interactive limactl shell with inherited stdio.
export async function limaInteractive(
  vmName: string,
  workdir: string,
  cmd: string[],
  opts: { tty?: boolean } = {},
): Promise<number> {
  const args = ["limactl", "shell"];
  if (opts.tty) args.push("--tty");
  args.push("--workdir", workdir, vmName, ...cmd);
  if (DRY_RUN) {
    console.error(`[dry-run] ${args.join(" ")}`);
    return 0;
  }
  const proc = spawn(args[0], args.slice(1), { stdio: "inherit" });
  return new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 0)));
}

// Pipe a script file into `limactl shell <vm> <shell> -l`.
export async function limaRunScript(
  vmName: string,
  workdir: string,
  scriptPath: string,
  shell: "bash" | "zsh",
): Promise<number> {
  if (DRY_RUN) {
    console.error(`[dry-run] limactl shell --workdir ${workdir} ${vmName} ${shell} -l < ${scriptPath}`);
    return 0;
  }
  const proc = spawn("limactl", ["shell", "--workdir", workdir, vmName, shell, "-l"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  createReadStream(scriptPath).pipe(proc.stdin!);
  return new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 0)));
}

export async function vmExists(name: string): Promise<boolean> {
  const r = await lima(["list", "-q"]);
  if (r.exitCode !== 0) return false;
  return r.stdout.split("\n").includes(name);
}

export async function vmRunning(name: string): Promise<boolean> {
  const r = await lima(["list", "--format", "{{.Name}} {{.Status}}"]);
  if (r.exitCode !== 0) return false;
  return r.stdout.split("\n").includes(`${name} Running`);
}

export async function printResources(name: string): Promise<void> {
  const r = await lima(["list", "--format", "{{.Name}}|{{.CPUs}}|{{.Memory}}|{{.Disk}}"]);
  if (r.exitCode !== 0) return;
  const line = r.stdout.split("\n").find((l) => l.startsWith(`${name}|`));
  if (!line) return;
  const [, cpus, memBytes, diskBytes] = line.split("|");
  const memGib = Math.floor(Number(memBytes) / 1024 ** 3);
  const diskGib = Math.floor(Number(diskBytes) / 1024 ** 3);
  console.log(`  Resources: CPUs: ${cpus}, Memory: ${memGib} GiB, Disk: ${diskGib} GiB`);
}

function vmNameFor(dir: string): string {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  const base = basename(dir).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `avm-${base}-${hash}`;
}

// Walks up from cwd looking for an existing VM; falls back to cwd if none found
// or if noInherit is set.
export async function resolveVm(cwd: string, noInherit: boolean, silent = false): Promise<ResolvedVm> {
  if (!noInherit) {
    let dir = cwd;
    while (true) {
      const candidate = vmNameFor(dir);
      if (await vmExists(candidate)) {
        if (dir !== cwd && !silent) {
          console.error(`Reusing VM '${candidate}' mounted at ${dir}`);
        }
        return { name: candidate, hostDir: dir };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { name: vmNameFor(cwd), hostDir: cwd };
}
