// Small things the Discord-only features share: filling in a server's
// message templates, durations as people type them, and "only moderators".

import type { OutMessage } from "./discord.ts";

export const msg = (content: string): OutMessage => ({ content });

/** "{user} reached level {level}" with the values filled in; unknown placeholders stay as typed. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => key in vars ? String(vars[key]) : whole);
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "10m", "1h30m", "2d", "90" (minutes) → milliseconds; null when it can't be read. */
export function parseDuration(input: string): number | null {
  const t = input.toLowerCase().replace(/\s+/g, "").replace(/(seconds?|secs?)/g, "s").replace(/(minutes?|mins?)/g, "m").replace(/(hours?|hrs?)/g, "h").replace(/(days?)/g, "d").replace(/(weeks?|wks?)/g, "w");
  if (/^\d+$/.test(t)) return Number(t) * 60_000;
  if (!/^(\d+[smhdw])+$/.test(t)) return null;
  let ms = 0;
  for (const [, n, u] of t.matchAll(/(\d+)([smhdw])/g)) ms += Number(n) * UNITS[u];
  return ms > 0 ? ms : null;
}

/** 5400000 → "1h 30m". */
export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(ms / 1000));
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.slice(0, 2).join(" ") || "0s";
}

/** ▰▰▰▱▱▱▱▱▱▱ */
export function progressBar(fraction: number, width = 12): string {
  const full = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "▰".repeat(full) + "▱".repeat(width - full);
}

export const mention = (userId: string) => `<@${userId}>`;

/** Comma-separated IDs in a TEXT column ↔ a list. */
export const idList = (csv: unknown): string[] => csv ? String(csv).split(",").filter(Boolean) : [];

export function pick<T>(list: T[], count: number): T[] {
  const pool = [...list];
  const out: T[] = [];
  while (pool.length && out.length < count) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}
