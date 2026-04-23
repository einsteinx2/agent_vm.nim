// Per-VM host loopback IP allocation for non-conflicting port forwarding.
//
// Each VM is assigned a slot in [2, 254] and uses 127.0.0.<slot> as its host
// IP. Slot 1 is reserved for pre-feature VMs (plain 127.0.0.1). Allocation
// state is one file per VM under ~/.agent-vm/slots/, containing the slot
// number as a decimal string.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SLOTS_DIR } from "./types.ts";

const MIN_SLOT = 2;
const MAX_SLOT = 254;

function ensureDir(): void {
  mkdirSync(SLOTS_DIR, { recursive: true });
}

function slotFile(vmName: string): string {
  return join(SLOTS_DIR, vmName);
}

function readUsedSlots(): Set<number> {
  ensureDir();
  const used = new Set<number>();
  for (const name of readdirSync(SLOTS_DIR)) {
    try {
      const n = Number(readFileSync(join(SLOTS_DIR, name), "utf8").trim());
      if (Number.isInteger(n) && n >= MIN_SLOT && n <= MAX_SLOT) used.add(n);
    } catch {}
  }
  return used;
}

export function getSlot(vmName: string): number | null {
  const f = slotFile(vmName);
  if (!existsSync(f)) return null;
  const n = Number(readFileSync(f, "utf8").trim());
  return Number.isInteger(n) && n >= MIN_SLOT && n <= MAX_SLOT ? n : null;
}

// Idempotent: returns the existing slot if already assigned, otherwise
// allocates the lowest unused slot and persists it.
export function allocateSlot(vmName: string): number {
  const existing = getSlot(vmName);
  if (existing !== null) return existing;
  const used = readUsedSlots();
  for (let n = MIN_SLOT; n <= MAX_SLOT; n++) {
    if (!used.has(n)) {
      ensureDir();
      writeFileSync(slotFile(vmName), `${n}\n`);
      return n;
    }
  }
  throw new Error(`No free slot available in [${MIN_SLOT}, ${MAX_SLOT}]; destroy unused VMs.`);
}

export function releaseSlot(vmName: string): void {
  try {
    unlinkSync(slotFile(vmName));
  } catch {}
}

export function hostIpFor(slot: number): string {
  return `127.0.0.${slot}`;
}
