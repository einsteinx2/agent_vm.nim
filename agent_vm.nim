#!/usr/bin/env -S nim r --hints:off --verbosity:0 --skipParentCfg:on --skipUserCfg:on
#
# agent_vm: Run AI coding agents inside sandboxed Lima VMs
# Part of https://github.com/einsteinx2/agent_vm.nim
#
# Install: symlink this file into a directory on $PATH (or add its directory
# to $PATH). First run compiles via `nim r`; subsequent runs are cached.
#
# Usage:
#   agent_vm setup    - Create the base VM template (run once)
#   agent_vm claude   - Run Claude Code in a persistent VM for cwd
#   agent_vm opencode - Run OpenCode in a persistent VM for cwd
#   agent_vm codex    - Run Codex CLI in a persistent VM for cwd
#   agent_vm shell    - Open a shell in the persistent VM for cwd
#   agent_vm run CMD  - Run a command in the persistent VM for cwd
#   agent_vm stop     - Stop the VM for cwd
#   agent_vm rm       - Stop and delete the VM for cwd
#   agent_vm list     - List all agent_vm VMs
#   agent_vm status   - Show status of all VMs (current dir marked with >)
#   agent_vm help     - Show help

import std/[os, osproc, strutils, streams, times, parseopt]

const AGENT_VM_TEMPLATE = "avm-base"
const compiledScriptDir = parentDir(currentSourcePath())

proc stateDir(): string = getHomeDir() / ".agent_vm"

proc scriptDir(): string =
  let envDir = getEnv("AGENT_VM_SCRIPT_DIR")
  if envDir.len > 0: envDir else: compiledScriptDir

# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

proc die(msg: string, code = 1) =
  stderr.writeLine(msg)
  quit(code)

# Run a subprocess and capture stdout. stderr is silently drained.
# Suitable for short-output commands like `limactl list -q`.
proc runCapture(cmd: string, args: openArray[string]): tuple[output: string, code: int] =
  let p = startProcess(cmd, args = @args, options = {poUsePath})
  let code = p.waitForExit()
  let output = p.outputStream.readAll()
  discard p.errorStream.readAll()
  p.close()
  (output, code)

# Run a subprocess, inheriting our stdin/stdout/stderr. TTY-correct for TUIs.
# Returns the child's exit code.
proc runInteractive(cmd: string, args: openArray[string]): int =
  let p = startProcess(cmd, args = @args, options = {poUsePath, poParentStreams})
  result = p.waitForExit()
  p.close()

# Run a subprocess, inherit stderr, silence stdout. Used for mutating commands
# like `limactl stop` / `limactl delete` where we don't want to see the output
# but do want errors to surface.
proc runQuiet(cmd: string, args: openArray[string]): int =
  let p = startProcess(cmd, args = @args, options = {poUsePath})
  result = p.waitForExit()
  discard p.outputStream.readAll()
  discard p.errorStream.readAll()
  p.close()

# Run a subprocess, feed `input` to its stdin, then inherit stdout/stderr
# streams by copying line-by-line. Used for streaming setup.sh / runtime.sh
# into `limactl shell bash -l`.
proc runWithStdin(cmd: string, args: openArray[string], input: string): int =
  let p = startProcess(cmd, args = @args, options = {poUsePath})
  p.inputStream.write(input)
  p.inputStream.close()
  # Forward output/error synchronously; scripts are short and bounded.
  let outStr = p.outputStream.readAll()
  let errStr = p.errorStream.readAll()
  if outStr.len > 0: stdout.write(outStr)
  if errStr.len > 0: stderr.write(errStr)
  result = p.waitForExit()
  p.close()

proc confirm(prompt: string): bool =
  stdout.write(prompt)
  stdout.flushFile()
  var line = ""
  try:
    line = stdin.readLine()
  except EOFError, IOError:
    return false
  line.len > 0 and line[0] in {'y', 'Y'}

# ---------------------------------------------------------------------------
# VM name + state queries
# ---------------------------------------------------------------------------

# Shell out to `shasum -a 256` to match the bash script byte-for-byte so VM
# names for existing projects stay identical across the bash→nim transition.
proc sha256Hex16(data: string): string =
  let p = startProcess("shasum", args = @["-a", "256"], options = {poUsePath})
  p.inputStream.write(data)
  p.inputStream.close()
  let output = p.outputStream.readAll()
  discard p.errorStream.readAll()
  discard p.waitForExit()
  p.close()
  if output.len < 16:
    die("shasum produced unexpected output: " & output.escape())
  output[0 ..< 16]

proc slugify(name: string): string =
  var s = ""
  var lastDash = false
  for c in name:
    if c.isAlphaNumeric:
      s.add c
      lastDash = false
    elif not lastDash:
      s.add '-'
      lastDash = true
  s.strip(chars = {'-'})

proc agentVmName(dir: string): string =
  "avm-" & slugify(extractFilename(dir)) & "-" & sha256Hex16(dir)

proc vmExists(name: string): bool =
  let (listOut, _) = runCapture("limactl", @["list", "-q"])
  for line in listOut.splitLines():
    if line == name: return true
  false

proc vmRunning(name: string): bool =
  let (listOut, _) = runCapture("limactl", @["list", "--format", "{{.Name}} {{.Status}}"])
  for line in listOut.splitLines():
    if line == name & " Running": return true
  false

proc printResources(vmName: string) =
  let (listOut, _) = runCapture("limactl",
    @["list", "--format", "{{.Name}}|{{.CPUs}}|{{.Memory}}|{{.Disk}}"])
  for line in listOut.splitLines():
    if line.startsWith(vmName & "|"):
      let parts = line.split('|')
      if parts.len >= 4:
        let cpus = parts[1]
        let memGib = parseBiggestInt(parts[2]) div 1073741824
        let diskGib = parseBiggestInt(parts[3]) div 1073741824
        echo "  Resources: CPUs: ", cpus, ", Memory: ", memGib, " GiB, Disk: ", diskGib, " GiB"
      return

proc listAgentVms(): seq[string] =
  let (listOut, _) = runCapture("limactl", @["list", "-q"])
  for line in listOut.splitLines():
    if line.startsWith("avm-"):
      result.add line

# ---------------------------------------------------------------------------
# VM resolution (ancestor walk)
# ---------------------------------------------------------------------------

type ResolvedVm = object
  name: string
  hostDir: string

proc resolveVm(cwd: string, noInherit: bool): ResolvedVm =
  if not noInherit:
    var dir = cwd
    while true:
      let candidate = agentVmName(dir)
      if vmExists(candidate):
        if dir != cwd:
          stderr.writeLine("Reusing VM '" & candidate & "' mounted at " & dir)
        return ResolvedVm(name: candidate, hostDir: dir)
      let parent = parentDir(dir)
      if parent.len == 0 or parent == dir: break
      dir = parent
  ResolvedVm(name: agentVmName(cwd), hostDir: cwd)

# ---------------------------------------------------------------------------
# VM options + arg parsing
# ---------------------------------------------------------------------------

type VmOpts = object
  disk: string
  memory: string
  cpus: string
  reset: bool
  offline: bool
  readonly: bool
  gitRo: bool
  rm: bool
  noInherit: bool

# Boolean flags that must NOT consume the next token as their value.
const vmBoolLongFlags = @[
  "reset", "offline", "readonly",
  "git-read-only", "git-ro",
  "rm", "no-inherit",
  "help"
]
# Value-taking flags (so we know which to route vs. treat as passthrough).
const vmValueLongFlags = @["disk", "memory", "ram", "cpus"]

proc isVmLongFlag(key: string): bool =
  key in vmBoolLongFlags or key in vmValueLongFlags

# Apply a recognised VM flag to `opts`. Returns true if key was recognised.
proc applyVmFlag(opts: var VmOpts, key, val: string): bool =
  case key
  of "disk":          opts.disk = val
  of "memory", "ram": opts.memory = val
  of "cpus":          opts.cpus = val
  of "reset":         opts.reset = true
  of "offline":       opts.offline = true
  of "readonly":      opts.readonly = true
  of "git-read-only", "git-ro": opts.gitRo = true
  of "rm":            opts.rm = true
  of "no-inherit":    opts.noInherit = true
  else: return false
  true

# Reconstruct an unrecognised option for passthrough to the inner agent.
proc reconstructOpt(kind: CmdLineKind, key, val: string): string =
  let prefix = if kind == cmdLongOption: "--" else: "-"
  if val.len == 0: prefix & key
  else: prefix & key & "=" & val

type ParsedArgs = object
  opts: VmOpts
  subcommand: string
  extras: seq[string]   # positional args / passthrough for the agent
  wantsHelp: bool

# Parse a full argv. All VM flags route to opts (regardless of position
# relative to the subcommand). First positional is the subcommand; remaining
# positionals and any unknown flags accumulate into `extras` in order.
proc parseArgs(argv: seq[string]): ParsedArgs =
  var p = initOptParser(argv, longNoVal = vmBoolLongFlags, shortNoVal = {'h'})
  for kind, key, val in p.getopt():
    case kind
    of cmdArgument:
      if result.subcommand.len == 0: result.subcommand = key
      else: result.extras.add key
    of cmdLongOption, cmdShortOption:
      if kind == cmdLongOption and isVmLongFlag(key):
        if key == "help":
          result.wantsHelp = true
        else:
          discard applyVmFlag(result.opts, key, val)
      elif kind == cmdShortOption and key == "h":
        result.wantsHelp = true
      else:
        result.extras.add reconstructOpt(kind, key, val)
    of cmdEnd: discard

# ---------------------------------------------------------------------------
# Ensure VM running (creating / starting / resizing as needed)
# ---------------------------------------------------------------------------

proc ensureRunning(vmName, hostDir: string, opts: VmOpts): bool =
  if not vmExists(AGENT_VM_TEMPLATE):
    stderr.writeLine("Error: Base VM not found. Run 'agent_vm setup' first.")
    return false

  # --reset: destroy existing VM before proceeding
  if opts.reset and vmExists(vmName):
    echo "Resetting VM '", vmName, "'..."
    discard runQuiet("limactl", @["stop", vmName])
    discard runQuiet("limactl", @["delete", vmName, "--force"])
    discard tryRemoveFile(stateDir() / (".agent_vm-version-" & vmName))

  let mountExpr = ".mounts = [{\"location\": \"" & hostDir & "\", \"writable\": true}]"

  if not vmExists(vmName):
    echo "Creating VM '", vmName, "'..."
    discard runQuiet("limactl", @["clone", AGENT_VM_TEMPLATE, vmName, "--tty=false"])
    # Apply mount and memory/cpus; disk is edited separately because Lima
    # rejects the entire edit if disk shrinking is attempted.
    var editArgs = @["edit", vmName, "--set", mountExpr]
    if opts.memory.len > 0: editArgs.add ["--memory", opts.memory]
    if opts.cpus.len > 0:   editArgs.add ["--cpus",   opts.cpus]
    let cwdSave = getCurrentDir()
    try:
      setCurrentDir("/tmp")
      discard runQuiet("limactl", editArgs)
      if opts.disk.len > 0:
        if runQuiet("limactl", @["edit", vmName, "--disk", opts.disk]) != 0:
          stderr.writeLine("Warning: Cannot set disk to " & opts.disk &
            " GiB (shrinking is not supported). Re-run 'agent_vm setup --disk " &
            opts.disk & "' for a smaller base.")
    finally:
      setCurrentDir(cwdSave)
    printResources(vmName)
    # Record which base version this VM was cloned from
    let baseVer = stateDir() / ".agent_vm-base-version"
    if fileExists(baseVer):
      copyFile(baseVer, stateDir() / (".agent_vm-version-" & vmName))
  elif opts.disk.len > 0 or opts.memory.len > 0 or opts.cpus.len > 0:
    # Auto-resize existing VM if any resource flag was passed
    if vmRunning(vmName):
      echo "VM '", vmName, "' is currently running. It must be stopped to apply new resource settings."
      if not confirm("Stop the VM and apply changes? [y/N] "):
        echo "Aborted. Starting with current settings."
        return true
      echo "Stopping VM..."
      discard runQuiet("limactl", @["stop", vmName])
    echo "Updating VM resources..."
    var editArgs = @["edit", vmName, "--set", mountExpr]
    if opts.memory.len > 0: editArgs.add ["--memory", opts.memory]
    if opts.cpus.len > 0:   editArgs.add ["--cpus",   opts.cpus]
    let cwdSave = getCurrentDir()
    try:
      setCurrentDir("/tmp")
      if runQuiet("limactl", editArgs) != 0:
        stderr.writeLine("Error: Failed to update VM resources.")
        return false
      if opts.disk.len > 0:
        if runQuiet("limactl", @["edit", vmName, "--disk", opts.disk]) != 0:
          stderr.writeLine("Warning: Cannot set disk to " & opts.disk &
            " GiB (shrinking is not supported). Re-run 'agent_vm setup --disk " &
            opts.disk & "' for a smaller base.")
    finally:
      setCurrentDir(cwdSave)
    printResources(vmName)

  # Warn if this VM was cloned from an older base
  let baseVer = stateDir() / ".agent_vm-base-version"
  let vmVer   = stateDir() / (".agent_vm-version-" & vmName)
  if fileExists(baseVer):
    let baseContent = readFile(baseVer)
    let stale = (not fileExists(vmVer)) or readFile(vmVer) != baseContent
    if stale:
      stderr.writeLine("Warning: Base VM has been updated since this VM was cloned. Use --reset to re-clone from the new base.")

  if not vmRunning(vmName):
    echo "Starting VM '", vmName, "'..."
    discard runQuiet("limactl", @["start", vmName])

  # Per-user runtime script
  let userRuntime = stateDir() / "runtime.sh"
  if fileExists(userRuntime):
    echo "Running user runtime setup..."
    discard runWithStdin("limactl",
      @["shell", "--workdir", hostDir, vmName, "zsh", "-l"], readFile(userRuntime))

  # Per-project runtime script
  let projRuntime = hostDir / ".agent_vm.runtime.sh"
  if fileExists(projRuntime):
    echo "Running project runtime setup..."
    discard runWithStdin("limactl",
      @["shell", "--workdir", hostDir, vmName, "zsh", "-l"], readFile(projRuntime))

  # Per-session restrictions
  if opts.offline:
    echo "Enabling offline mode..."
    discard runQuiet("limactl", @["shell", vmName, "sudo", "iptables", "-F", "OUTPUT"])
    discard runQuiet("limactl", @["shell", vmName, "sudo", "iptables", "-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT"])
    discard runQuiet("limactl", @["shell", vmName, "sudo", "iptables", "-A", "OUTPUT", "-d", "10.0.0.0/8", "-j", "ACCEPT"])
    discard runQuiet("limactl", @["shell", vmName, "sudo", "iptables", "-A", "OUTPUT", "-d", "172.16.0.0/12", "-j", "ACCEPT"])
    discard runQuiet("limactl", @["shell", vmName, "sudo", "iptables", "-A", "OUTPUT", "-d", "192.168.0.0/16", "-j", "ACCEPT"])
    discard runQuiet("limactl", @["shell", vmName, "sudo", "iptables", "-P", "OUTPUT", "DROP"])

  if opts.readonly:
    echo "Mounting project directory as read-only..."
    discard runQuiet("limactl", @["shell", vmName, "sudo", "mount", "-o", "remount,ro", hostDir])

  if opts.gitRo and dirExists(hostDir / ".git"):
    echo "Mounting .git directory as read-only..."
    let gitDir = hostDir / ".git"
    discard runQuiet("limactl", @["shell", vmName, "sudo", "mount", "--bind", gitDir, gitDir])
    discard runQuiet("limactl", @["shell", vmName, "sudo", "mount", "-o", "remount,ro,bind", gitDir])

  true

# ---------------------------------------------------------------------------
# VM destruction
# ---------------------------------------------------------------------------

proc destroyVm(force = false, noInherit = false) =
  let cwd = getCurrentDir()
  let r = resolveVm(cwd, noInherit)
  if not vmExists(r.name):
    stderr.writeLine("No VM found for this directory.")
    quit(1)
  if r.hostDir != cwd and not force:
    echo "VM '", r.name, "' is mounted at ", r.hostDir, ", which is shared with parent directories."
    if not confirm("Destroy it anyway? [y/N] "):
      echo "Aborted."
      quit(1)
  echo "Stopping and deleting VM '", r.name, "' (mounted at ", r.hostDir, ")..."
  discard runQuiet("limactl", @["stop", r.name])
  discard runQuiet("limactl", @["delete", r.name, "--force"])
  discard tryRemoveFile(stateDir() / (".agent_vm-version-" & r.name))
  echo "VM destroyed."

proc stopVm(noInherit = false) =
  let cwd = getCurrentDir()
  let r = resolveVm(cwd, noInherit)
  if not vmExists(r.name):
    stderr.writeLine("No VM found for this directory.")
    quit(1)
  echo "Stopping VM '", r.name, "' (mounted at ", r.hostDir, ")..."
  discard runQuiet("limactl", @["stop", r.name])
  echo "VM stopped."

proc destroyAllVms() =
  let vms = listAgentVms()
  if vms.len == 0:
    echo "No agent_vm VMs found."
    return
  echo "This will destroy the following VMs:"
  for v in vms: echo v
  if not confirm("Continue? [y/N] "):
    echo "Aborted."
    return
  for v in vms:
    echo "Destroying ", v, "..."
    discard runQuiet("limactl", @["stop", v])
    discard runQuiet("limactl", @["delete", v, "--force"])
    discard tryRemoveFile(stateDir() / (".agent_vm-version-" & v))
  echo "All VMs destroyed."

# ---------------------------------------------------------------------------
# Subcommand handlers
# ---------------------------------------------------------------------------

# Shared: resolve VM, reject --rm when inherited, ensure it's running, then
# hand control to the given command inside the VM. `cwd` is our current dir;
# the VM's mount root is `hostDir` (may be an ancestor of cwd).
proc runAgent(opts: VmOpts, passthrough: seq[string],
              binary: string, binaryPrefix: openArray[string]) =
  let cwd = getCurrentDir()
  let r = resolveVm(cwd, opts.noInherit)
  if opts.rm and r.hostDir != cwd:
    stderr.writeLine("Error: --rm would destroy VM '" & r.name & "' mounted at " & r.hostDir &
                     ", which is shared with parent directories.")
    stderr.writeLine("Run --rm from " & r.hostDir & ", or use --no-inherit to create a fresh VM for " & cwd & ".")
    quit(1)

  if not ensureRunning(r.name, r.hostDir, opts):
    quit(1)
  printResources(r.name)

  var args = @["shell"]
  if binary == "opencode":
    args.add "--tty"
  args.add ["--workdir", cwd, r.name, binary]
  for x in binaryPrefix: args.add x
  for x in passthrough: args.add x

  let code = runInteractive("limactl", args)
  if opts.rm:
    echo "Removing VM..."
    destroyVm(force = true)
  quit(code)

proc cmdClaude(p: ParsedArgs) =
  runAgent(p.opts, p.extras, "claude", ["--dangerously-skip-permissions"])

proc cmdOpencode(p: ParsedArgs) =
  # TODO: add --dangerously-skip-permissions once released
  runAgent(p.opts, p.extras, "opencode", [])

proc cmdCodex(p: ParsedArgs) =
  runAgent(p.opts, p.extras, "codex", ["--full-auto"])

proc cmdShell(p: ParsedArgs) =
  let cwd = getCurrentDir()
  let r = resolveVm(cwd, p.opts.noInherit)
  if p.opts.rm and r.hostDir != cwd:
    stderr.writeLine("Error: --rm would destroy VM '" & r.name & "' mounted at " & r.hostDir &
                     ", which is shared with parent directories.")
    stderr.writeLine("Run --rm from " & r.hostDir & ", or use --no-inherit to create a fresh VM for " & cwd & ".")
    quit(1)
  if not ensureRunning(r.name, r.hostDir, p.opts): quit(1)
  printResources(r.name)
  echo "VM: ", r.name, " | Mount: ", r.hostDir, " | Workdir: ", cwd
  if p.opts.rm:
    echo "Type 'exit' to leave. VM will be destroyed after exit."
  else:
    echo "Type 'exit' to leave (VM keeps running). Use 'agent_vm stop' to stop it."
  let code = runInteractive("limactl", @["shell", "--workdir", cwd, r.name, "zsh", "-l"])
  if p.opts.rm:
    echo "Removing VM..."
    destroyVm(force = true)
  quit(code)

proc cmdRun(p: ParsedArgs) =
  if p.extras.len == 0:
    stderr.writeLine("Usage: agent_vm run <command> [args]")
    quit(1)
  let cwd = getCurrentDir()
  let r = resolveVm(cwd, p.opts.noInherit)
  if p.opts.rm and r.hostDir != cwd:
    stderr.writeLine("Error: --rm would destroy VM '" & r.name & "' mounted at " & r.hostDir &
                     ", which is shared with parent directories.")
    stderr.writeLine("Run --rm from " & r.hostDir & ", or use --no-inherit to create a fresh VM for " & cwd & ".")
    quit(1)
  if not ensureRunning(r.name, r.hostDir, p.opts): quit(1)
  printResources(r.name)
  var args = @["shell", "--workdir", cwd, r.name]
  for x in p.extras: args.add x
  let code = runInteractive("limactl", args)
  if p.opts.rm:
    echo "Removing VM..."
    destroyVm(force = true)
  quit(code)

proc cmdStop(p: ParsedArgs) =
  stopVm(noInherit = p.opts.noInherit)

proc cmdRm(p: ParsedArgs) =
  # Support `agent_vm rm -y` / `--yes` via extras: the user might have passed
  # -y which parseopt captured as a short option unknown to our flags.
  var force = false
  for x in p.extras:
    if x == "-y" or x == "--yes": force = true
  destroyVm(force = force, noInherit = p.opts.noInherit)

proc cmdList(p: ParsedArgs) =
  let (header, _) = runCapture("limactl", @["list"])
  let lines = header.splitLines()
  if lines.len > 0: echo lines[0]
  var any = false
  for line in lines[1 .. ^1]:
    if line.startsWith("avm-"):
      echo line; any = true
  if not any: echo "(no VMs)"

proc cmdStatus(p: ParsedArgs) =
  let cwd = getCurrentDir()
  let resolved = resolveVm(cwd, false)
  var currentName = ""
  var currentHost = ""
  if vmExists(resolved.name):
    currentName = resolved.name
    currentHost = resolved.hostDir
  let (listOut, _) = runCapture("limactl", @["list"])
  let lines = listOut.splitLines()
  echo "VMs (current directory: ", cwd, "):"
  if currentName.len > 0 and currentHost != cwd:
    echo "Inherited VM '", currentName, "' (mounted at ", currentHost, ")"
  echo ""
  if lines.len > 0: echo "  ", lines[0]
  var any = false
  for line in lines[1 .. ^1]:
    if line.startsWith("avm-"):
      let vmName = line.split()[0]
      if vmName == currentName: echo "> ", line
      else: echo "  ", line
      any = true
  if not any: echo "  (no VMs)"

proc cmdSetup(p: ParsedArgs) =
  var disk = if p.opts.disk.len > 0: p.opts.disk else: "10"
  var memory = if p.opts.memory.len > 0: p.opts.memory else: "2"
  var cpus = if p.opts.cpus.len > 0: p.opts.cpus else: "1"

  if findExe("limactl").len == 0:
    if findExe("brew").len > 0:
      echo "Installing Lima..."
      if runInteractive("brew", @["install", "lima"]) != 0:
        die("Error: Failed to install Lima.")
    else:
      die("Error: Lima is required. Install from https://lima-vm.io/docs/installation/")

  discard runQuiet("limactl", @["stop", AGENT_VM_TEMPLATE])
  discard runQuiet("limactl", @["delete", AGENT_VM_TEMPLATE, "--force"])

  echo "Creating base VM..."
  var createArgs = @["create", "--name=" & AGENT_VM_TEMPLATE, "template:debian-13",
                     "--set", ".mounts=[]",
                     "--disk=" & disk, "--memory=" & memory, "--tty=false"]
  if cpus.len > 0: createArgs.add "--cpus=" & cpus
  if runQuiet("limactl", createArgs) != 0:
    die("Error: Failed to create base VM.")

  printResources(AGENT_VM_TEMPLATE)

  if runQuiet("limactl", @["start", AGENT_VM_TEMPLATE]) != 0:
    die("Error: Failed to start base VM.")

  echo "Installing packages inside VM..."
  let setupPath = scriptDir() / "agent_vm.setup.sh"
  if not fileExists(setupPath):
    die("Error: Setup script not found: " & setupPath)
  if runWithStdin("limactl",
      @["shell", AGENT_VM_TEMPLATE, "bash", "-l"], readFile(setupPath)) != 0:
    die("Error: Setup script failed.")

  let userSetup = stateDir() / "setup.sh"
  if fileExists(userSetup):
    echo "Running custom setup from ", userSetup, "..."
    if runWithStdin("limactl",
        @["shell", AGENT_VM_TEMPLATE, "zsh", "-l"], readFile(userSetup)) != 0:
      die("Error: Custom setup script failed.")

  discard runQuiet("limactl", @["stop", AGENT_VM_TEMPLATE])

  createDir(stateDir())
  writeFile(stateDir() / ".agent_vm-base-version", $toUnix(getTime()))

  echo ""
  echo "Base VM ready. Run 'agent_vm shell', 'agent_vm claude', 'agent_vm opencode', or 'agent_vm codex' in any project directory."
  echo "Note: Existing VMs were not updated. Use --reset to re-clone them from the new base."

proc cmdHelp() =
  echo """Usage: agent_vm [options] <command> [args]

Commands:
  setup              Create the base VM template (run once)
  claude [args]      Run Claude Code in the VM for the current directory
  opencode [args]    Run OpenCode in the VM for the current directory
  codex [args]       Run Codex CLI in the VM for the current directory
  shell              Open a shell in the VM for the current directory
  run <cmd> [args]   Run a command in the VM for the current directory
  stop               Stop the VM for the current directory
  rm                 Stop and delete the VM for the current directory
  destroy-all        Stop and delete all agent_vm VMs
  list               List all agent_vm VMs
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
  agent_vm setup                             # Create base VM
  agent_vm claude                            # Run Claude in a VM
  agent_vm opencode                          # Run OpenCode in a VM
  agent_vm codex                             # Run Codex in a VM
  agent_vm --disk 50 --memory 16 --cpus 8 claude  # Custom resources
  agent_vm --reset claude                    # Fresh VM from base template
  agent_vm --rm claude                       # Destroy VM after Claude exits
  agent_vm --offline claude                  # No internet access
  agent_vm --readonly shell                  # Read-only project mount
  agent_vm --git-ro claude                   # Protect .git from writes
  agent_vm shell                             # Shell into the VM
  agent_vm run npm install                   # Run a command in the VM
  agent_vm claude -p "fix lint errors"       # Pass args to claude

VMs are persistent and unique per directory. Running "agent_vm shell" or
"agent_vm claude" in the same directory will reuse the same VM. Running
from a subdirectory reuses the nearest ancestor's VM (use --no-inherit to
force a new VM scoped to cwd).

Customization:
  ~/.agent_vm/setup.sh              Per-user setup (runs during "agent_vm setup")
  ~/.agent_vm/runtime.sh            Per-user runtime (runs on each VM start)
  <project>/.agent_vm.runtime.sh    Per-project runtime (runs on each VM start)

More info: https://github.com/einsteinx2/agent_vm.nim"""

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------

proc main() =
  # Keep our process alive when the attached child (claude/opencode/codex/shell)
  # receives Ctrl+C, so the child can handle the signal and exit cleanly.
  setControlCHook(proc() {.noconv.} = discard)

  let argv = commandLineParams()
  let parsed = parseArgs(argv)

  if parsed.wantsHelp or parsed.subcommand.len == 0 or parsed.subcommand == "help":
    cmdHelp(); return

  case parsed.subcommand
  of "setup":       cmdSetup(parsed)
  of "claude":      cmdClaude(parsed)
  of "opencode":    cmdOpencode(parsed)
  of "codex":       cmdCodex(parsed)
  of "shell":       cmdShell(parsed)
  of "run":         cmdRun(parsed)
  of "stop":        cmdStop(parsed)
  of "rm", "destroy": cmdRm(parsed)
  of "destroy-all": destroyAllVms()
  of "list":        cmdList(parsed)
  of "status":      cmdStatus(parsed)
  else:
    stderr.writeLine("Unknown command: " & parsed.subcommand)
    stderr.writeLine("Run 'agent_vm help' for usage.")
    quit(1)

main()
