// Command-line argument parsing.

import { emptyOpts, type VmOptions } from "./types.ts";

// Parses global flags until the first non-flag token, which becomes the
// subcommand. Unknown tokens (including unknown flags) end the parse; the
// subcommand's handler decides what to do with them.
export function parseGlobals(argv: string[]): { opts: VmOptions; command: string; rest: string[] } {
  const { opts, stopAt } = consumeVmFlags(argv, /*stopOnUnknown*/ true);
  const command = argv[stopAt] ?? "help";
  const rest = argv.slice(stopAt + (argv[stopAt] === undefined ? 0 : 1));
  return { opts, command, rest };
}

// Parses VM flags from anywhere in argv (after the subcommand); unknown tokens
// are preserved as passthrough so the agent command receives them verbatim
// (e.g. `claude -p "fix lint"`).
export function parseSubArgs(argv: string[]): { opts: VmOptions; passthrough: string[] } {
  const { opts, passthrough } = consumeVmFlags(argv, /*stopOnUnknown*/ false);
  return { opts, passthrough: passthrough ?? [] };
}

// Core flag consumer. `stopOnUnknown`: when true, halts at the first unknown
// token and returns its index in `stopAt`; when false, collects unknowns into
// `passthrough` and continues.
function consumeVmFlags(
  argv: string[],
  stopOnUnknown: boolean,
): { opts: VmOptions; stopAt: number; passthrough?: string[] } {
  const opts = emptyOpts();
  const passthrough: string[] = [];
  let i = 0;

  const takeValue = (arg: string, flag: string): string => {
    const eq = arg.indexOf("=");
    if (eq !== -1) return arg.slice(eq + 1);
    const next = argv[i + 1];
    if (next === undefined) {
      console.error(`Error: ${flag} requires a value`);
      process.exit(1);
    }
    i++;
    return next;
  };

  while (i < argv.length) {
    const a = argv[i];
    const name = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    let handled = true;
    switch (name) {
      case "--disk":
        opts.disk = takeValue(a, "--disk");
        break;
      case "--memory":
      case "--ram":
        opts.memory = takeValue(a, name);
        break;
      case "--cpus":
        opts.cpus = takeValue(a, "--cpus");
        break;
      case "--reset":
        opts.reset = true;
        break;
      case "--offline":
        opts.offline = true;
        break;
      case "--readonly":
        opts.readonly = true;
        break;
      case "--git-read-only":
      case "--git-ro":
        opts.gitRo = true;
        break;
      case "--rm":
        opts.rm = true;
        break;
      case "--no-inherit":
        opts.noInherit = true;
        break;
      default:
        handled = false;
    }
    if (!handled) {
      if (stopOnUnknown) {
        return { opts, stopAt: i };
      }
      passthrough.push(a);
    }
    i++;
  }
  return { opts, stopAt: i, passthrough: stopOnUnknown ? undefined : passthrough };
}
