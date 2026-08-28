/**
 * Scheduling.
 *
 * Two ways to put messages on a calendar, both lifted from how the old
 * desktop schedulers worked:
 *
 *   slots     — named times on chosen weekdays ("09:15 and 17:40, Mon–Fri")
 *   interval  — every N to M minutes inside an active window, which is what
 *               you want for a drip campaign that should not look metronomic
 *
 * Both produce plain ISO timestamps, so the queue, the calendar and the Worker
 * cron all read the same thing.
 */

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm || "0:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function atMinutes(day, minutes) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

function randInt(a, b, random = Math.random) {
  return Math.floor(random() * (b - a + 1)) + a;
}

/**
 * Expand a schedule into `count` upcoming Date objects.
 *
 * schedule = {
 *   mode: "slots" | "interval",
 *   days: [0..6],                 // weekdays the schedule is active
 *   times: ["09:00", "17:30"],    // slots mode
 *   from: "09:00", to: "18:00",   // interval mode window
 *   everyMin: 45, everyMaxMin: 90,// interval mode gap, randomised in range
 *   jitterMin: 0,                 // slots mode: ± minutes of scatter
 *   startAt: ISO,                 // do not schedule before this
 * }
 */
export function expand(schedule, count, { from = new Date(), random = Math.random } = {}) {
  const s = schedule || {};
  const days = (s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6]).map(Number);
  const start = s.startAt && new Date(s.startAt) > from ? new Date(s.startAt) : new Date(from);
  const out = [];

  if (s.mode === "interval") {
    const winFrom = hhmmToMinutes(s.from || "09:00");
    const winTo = hhmmToMinutes(s.to || "21:00");
    const gapMin = Math.max(1, Number(s.everyMin) || 45);
    const gapMax = Math.max(gapMin, Number(s.everyMaxMin) || gapMin);

    let cursor = new Date(start);
    let guard = 0;
    while (out.length < count && guard++ < count * 400 + 2000) {
      const minutes = cursor.getHours() * 60 + cursor.getMinutes();
      if (!days.includes(cursor.getDay()) || minutes >= winTo) {
        // Jump to the window opening on the next active day.
        cursor = atMinutes(new Date(cursor.getTime() + 864e5), winFrom);
        continue;
      }
      if (minutes < winFrom) { cursor = atMinutes(cursor, winFrom); continue; }
      out.push(new Date(cursor));
      cursor = new Date(cursor.getTime() + randInt(gapMin, gapMax, random) * 60000);
    }
    return out;
  }

  // slots mode
  const times = (s.times && s.times.length ? s.times : ["09:00", "13:00", "17:00"])
    .map(hhmmToMinutes).sort((a, b) => a - b);
  const jitter = Math.max(0, Number(s.jitterMin) || 0);

  let day = new Date(start);
  day.setHours(0, 0, 0, 0);
  let guard = 0;
  while (out.length < count && guard++ < 1500) {
    if (days.includes(day.getDay())) {
      for (const t of times) {
        if (out.length >= count) break;
        const when = atMinutes(day, t + (jitter ? randInt(-jitter, jitter, random) : 0));
        if (when > start) out.push(when);
      }
    }
    day = new Date(day.getTime() + 864e5);
  }
  return out.sort((a, b) => a - b).slice(0, count);
}

/** One-line description of a schedule, for the queue and rule summaries. */
export function describe(schedule) {
  const s = schedule || {};
  const days = s.days && s.days.length && s.days.length < 7
    ? s.days.slice().sort().map((d) => DAY_NAMES[d]).join(", ")
    : "every day";
  if (s.mode === "interval") {
    const gap = s.everyMaxMin && s.everyMaxMin !== s.everyMin
      ? `every ${s.everyMin}–${s.everyMaxMin} min`
      : `every ${s.everyMin || 45} min`;
    return `${gap}, ${s.from || "09:00"}–${s.to || "21:00"}, ${days}`;
  }
  const times = (s.times || []).join(", ") || "09:00, 13:00, 17:00";
  return `${times}${s.jitterMin ? ` (±${s.jitterMin} min)` : ""}, ${days}`;
}

/**
 * Lay a pool of messages onto a schedule.
 *
 * `assignments` is a list of { accountIds, text }; each gets the next slot, so
 * a 30-message pool across 3 slots a day becomes 10 days of posting.
 */
export function drip(assignments, schedule, opts = {}) {
  const slots = expand(schedule, assignments.length, opts);
  return assignments.map((a, i) => ({
    ...a,
    scheduledAt: (slots[i] || slots[slots.length - 1] || new Date()).toISOString(),
  }));
}

/** Posts that are due to go out now (or overdue). */
export function due(posts, now = new Date()) {
  return posts.filter((p) => p.status === "queued" && p.scheduledAt && new Date(p.scheduledAt) <= now);
}

/** Next scheduled post, if any. */
export function nextUp(posts, now = new Date()) {
  return posts
    .filter((p) => p.status === "queued" && p.scheduledAt && new Date(p.scheduledAt) > now)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0] || null;
}

/** Group posts by local YYYY-MM-DD, for the calendar. */
export function byDay(posts) {
  const map = new Map();
  for (const p of posts) {
    if (!p.scheduledAt) continue;
    const d = new Date(p.scheduledAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  for (const list of map.values()) list.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  return map;
}

/** Is `when` inside the configured quiet hours? */
export function inQuietHours(when, quiet) {
  if (!quiet || !quiet.enabled) return false;
  const d = when instanceof Date ? when : new Date(when);
  const m = d.getHours() * 60 + d.getMinutes();
  const from = hhmmToMinutes(quiet.from || "23:00");
  const to = hhmmToMinutes(quiet.to || "06:00");
  return from <= to ? (m >= from && m < to) : (m >= from || m < to);
}

/** Push a time out of quiet hours to the moment they end. */
export function avoidQuietHours(when, quiet) {
  if (!inQuietHours(when, quiet)) return when;
  const d = new Date(when);
  const to = hhmmToMinutes(quiet.to || "06:00");
  const m = d.getHours() * 60 + d.getMinutes();
  if (m >= to) d.setDate(d.getDate() + 1);
  return atMinutes(d, to);
}
