# agent_vm — repo orientation

A Nim shebang script that wraps `limactl` to run AI coding agents in per-directory Lima VMs. The Nim source is [agent_vm.nim](agent_vm.nim); it runs via a `nim r` shebang. No nimble project, no Makefile, no tests — verification is end-to-end against a real Lima install.

## Runtime model

- First invocation compiles [agent_vm.nim](agent_vm.nim) via `nim r` and caches the binary under `~/.cache/nim/`. Subsequent runs are fast (nim checks mtime and skips the rebuild).
- Editing [agent_vm.nim](agent_vm.nim) triggers a recompile on next invocation.
- Editing [agent_vm.setup.sh](agent_vm.setup.sh) does **not** trigger a recompile — it's loaded at runtime, not `staticRead`-ed. Path is resolved from `currentSourcePath()` at compile time (with `AGENT_VM_SCRIPT_DIR` env override).
- `nim r` prints `Error: execution of an external program failed: ...` to stderr whenever our program exits non-zero. Exit codes still propagate correctly; the real error message from our code appears first. Cosmetic only.

## External commands

All real work is shelled out. The Nim code only coordinates.

- `limactl` — `list`, `create`, `clone`, `edit`, `start`, `stop`, `delete`, `shell`
- `shasum -a 256` — the VM-name hash (byte-compatible with the bash version)
- `brew install lima` — optional, only in `cmdSetup` when Lima is missing
- Inside the VM, via `limactl shell`: `iptables` (offline mode), `mount` (readonly / git-ro), `sudo`, `zsh`, `bash`

## Key gotchas

- **`getAppFilename()` under `nim r`** points at the cached binary in nimcache, NOT the source file. Always use `currentSourcePath()` when locating sibling files.
- **Module name must be a valid Nim identifier.** That's why the file is `agent_vm.nim` (underscore) rather than `agent-vm.nim` — a hyphen would fail to compile under `nim r`. Users symlink `agent_vm` → `agent_vm.nim` on their `$PATH`.
- **Process execution uses `startProcess` with `{poParentStreams, poUsePath}`** for interactive commands (claude/opencode/codex/shell). This hands our TTY directly to the child — TUIs, Ctrl+C, arrow keys all work. **Never use `execShellCmd`** — it re-introduces shell quoting bugs for things like `limactl edit --set '.mounts=[{"location":"..."}]'`.
- **Ctrl+C forwarding**: `setControlCHook(proc() {.noconv.} = discard)` is installed so SIGINT reaches the agent (via `limactl`) before it kills our Nim process.
- **VM name format** is `avm-<slug>-<16hex>` where `<16hex>` is the first 16 chars of `sha256(dir_path)` with **no trailing newline** on the input. Any drift here renames all existing VMs.
- **`--rm` is refused** when the resolved VM is inherited from an ancestor directory — the VM is shared state, not ours to destroy.
- **Nim keywords to avoid as identifiers**: `out` is reserved. `output`, `listOut`, etc. are fine.

## Files

| File | Role |
|---|---|
| [agent_vm.nim](agent_vm.nim) | The port. Single source of truth for host-side behavior. |
| [agent_vm.setup.sh](agent_vm.setup.sh) | Runs **inside** the Debian VM during `agent_vm setup`. Stays bash. |
| [runtime.example.sh](runtime.example.sh) | User-facing template for `~/.agent_vm/runtime.sh`. |
| [README.md](README.md) | User-facing docs. Keep in sync with the flag set in `agent_vm.nim`. |
