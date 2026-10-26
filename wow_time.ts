// When a WoW raid starts: what a raid leader types ("fri 8pm", "tomorrow
// 19:30", "11/8 8:30pm", "2026-11-08 20:00", "in 2h") read in a timezone,
// as a UTC instant. Discord then shows it to every member in their own
// timezone (<t:…:F>), so the leader only thinks in theirs.
//
// No libraries: an IANA zone's offset at an instant comes from
// Intl.DateTimeFormat, which knows daylight saving.

/** /wow raid create's timezone choices: label → IANA zone. */
export const TIMEZONES: Array<[string, string]> = [
  ["US Eastern", "America/New_York"],
  ["US Central", "America/Chicago"],
  ["US Mountain", "America/Denver"],
  ["US Arizona", "America/Phoenix"],
  ["US Pacific", "America/Los_Angeles"],
  ["Alaska", "America/Anchorage"],
  ["Hawaii", "Pacific/Honolulu"],
  ["UTC", "UTC"],
  ["UK & Ireland", "Europe/London"],
  ["Central Europe", "Europe/Berlin"],
  ["Eastern Europe", "Europe/Helsinki"],
  ["Brazil (São Paulo)", "America/Sao_Paulo"],
  ["Australia East", "Australia/Sydney"],
  ["New Zealand", "Pacific/Auckland"],
];

export const DEFAULT_TIMEZONE = Deno.env.get("WOW_DEFAULT_TIMEZONE") || "America/New_York";

export function timezoneLabel(zone: string): string {
  return TIMEZONES.find(([, z]) => z === zone)?.[0] ?? zone;
}

const partsFormat = new Map<string, Intl.DateTimeFormat>();

/** The zone's wall clock at a UTC instant. */
export function wallClock(zone: string, utcMs: number) {
  let f = partsFormat.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    partsFormat.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday)),
  };
}

function offsetMs(zone: string, utcMs: number): number {
  const w = wallClock(zone, utcMs);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock time in a zone → UTC ms (the later reading when the clocks go back). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMs(zone, guess);
  const second = guess - offsetMs(zone, first);
  return second;
}

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type When = { at: number } | { error: string };

const HINT = 'Try e.g. "fri 8pm", "tomorrow 19:30", "11/8 8:30pm", "2026-11-08 20:00" or "in 2h".';

/** Reads a start time. `now` is for tests. */
export function parseWhen(input: string, zone: string, now = Date.now()): When {
  let s = input.toLowerCase().replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return { error: `When does it start? ${HINT}` };

  // "in 2h", "in 90m", "in 1h 30m", "in 2 hours"
  const rel = s.match(/^in\s+(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?$/);
  if (rel && (rel[1] || rel[2])) {
    const ms = (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
    if (ms < 60_000) return { error: "That's already now. Give it at least a minute." };
    return { at: Math.ceil((now + ms) / 60_000) * 60_000 };
  }

  // The time of day: "8pm", "8:30 pm", "20:00", "noon", "midnight".
  let hour: number | null = null;
  let minute = 0;
  const named = s.match(/\b(noon|midnight)\b/);
  if (named) {
    hour = named[1] === "noon" ? 12 : 0;
    s = s.replace(named[0], " ");
  } else {
    const t = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)\b/) ?? s.match(/\b(\d{1,2}):(\d{2})\b()/);
    if (t) {
      hour = Number(t[1]);
      minute = Number(t[2] ?? 0);
      const ap = t[3];
      if (ap) {
        if (hour < 1 || hour > 12) return { error: `${t[0]} isn't a time. ${HINT}` };
        if (ap.startsWith("p") && hour !== 12) hour += 12;
        if (ap.startsWith("a") && hour === 12) hour = 0;
      }
      if (hour > 23 || minute > 59) return { error: `${t[0].trim()} isn't a time. ${HINT}` };
      s = s.replace(t[0], " ");
    }
  }
  if (hour === null) return { error: `What time? ${HINT}` };
  s = s.replace(/\s+/g, " ").replace(/\b(at|on|this|next)\b/g, " ").trim();

  const today = wallClock(zone, now);
  let date: { y: number; mo: number; d: number } | null = null;
  let yearGiven = true;
  let weekday = -1;
  let m: RegExpMatchArray | null;

  if (!s || s === "today" || s === "tonight") {
    date = { y: today.y, mo: today.mo, d: today.d };
    if (!s) yearGiven = false; // bare time: today, or tomorrow once it's passed
  } else if (s === "tomorrow" || s === "tmrw" || s === "tmr") {
    const t = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1));
    date = { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  } else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    date = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/))) {
    const y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : today.y;
    yearGiven = Boolean(m[3]);
    date = { y, mo: Number(m[1]), d: Number(m[2]) };
  } else if ((m = s.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/)) || (m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?(?: (\d{4}))?$/))) {
    const [word, day] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const mo = MONTHS.indexOf(word.slice(0, 3)) + 1;
    if (!mo) return { error: `"${word}" isn't a month. ${HINT}` };
    yearGiven = Boolean(m[3]);
    date = { y: m[3] ? Number(m[3]) : today.y, mo, d: Number(day) };
  } else if ((weekday = WEEKDAYS.indexOf(s.slice(0, 3))) >= 0 && /^[a-z]+$/.test(s)) {
    const ahead = (weekday - today.weekday + 7) % 7;
    const t = new Date(Date.UTC(today.y, today.mo - 1, today.d + ahead));
    date = { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  } else {
    return { error: `I couldn't read "${input.trim()}". ${HINT}` };
  }

  const check = new Date(Date.UTC(date.y, date.mo - 1, date.d));
  if (check.getUTCMonth() + 1 !== date.mo || check.getUTCDate() !== date.d) return { error: `There's no ${date.mo}/${date.d}. ${HINT}` };

  let at = zonedToUtc(date.y, date.mo, date.d, hour, minute, zone);
  if (at <= now) {
    if (!s) at = zonedToUtc(date.y, date.mo, date.d + 1, hour, minute, zone); // "8pm" after 8pm → tomorrow
    else if (weekday >= 0) at = zonedToUtc(date.y, date.mo, date.d + 7, hour, minute, zone); // "fri" late on Friday → next week
    else if (!yearGiven && now - at > 86_400_000) at = zonedToUtc(date.y + 1, date.mo, date.d, hour, minute, zone); // "1/5" in December
  }
  if (at <= now) return { error: `That time has already passed (${timezoneLabel(zone)}). ${HINT}` };
  if (at - now > 366 * 86_400_000) return { error: "That's more than a year away. Pick a date within the next year." };
  return { at };
}

/** Discord timestamp markup: shown in each reader's own timezone. */
export const stamp = (ms: number, style: "F" | "f" | "R" | "t" | "D" | "d" = "F") => `<t:${Math.floor(ms / 1000)}:${style}>`;
