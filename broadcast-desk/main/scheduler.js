/**
 * The in-app scheduler.
 *
 * The relay's cron is what sends when this machine is off. This is what sends
 * while it is on — and it is the only sender for accounts the operator chose
 * to keep local-only, which is most of the media-heavy ones, because their
 * files are on this disk and nowhere else.
 *
 * The two never both own the same post: the renderer hands over only the
 * entries whose accounts are marked unattended, and keeps the rest here.
 */

let queue = [];          // [{ id, scheduledAt, items:[…] }]
let timer = null;
let sending = false;
let hooks = { send: async () => [], notify: () => {} };
let lastRun = null;

function start(h) {
  hooks = { ...hooks, ...h };
  stop();
  // Half a minute is fine: nothing here is scheduled to the second, and a
  // tighter loop only burns battery.
  timer = setInterval(tick, 30000);
  timer.unref && timer.unref();
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function setQueue(posts) {
  queue = (posts || []).filter((p) => p && p.id && p.scheduledAt && (p.items || []).length);
  return summary();
}

function due(now = Date.now()) {
  return queue.filter((p) => new Date(p.scheduledAt).getTime() <= now);
}

async function tick() {
  if (sending) return;
  const ready = due();
  if (!ready.length) return;
  await run(ready);
}

async function runNow() {
  const ready = due(Date.now() + 1000);
  if (!ready.length) return { sent: 0 };
  return run(ready);
}

async function run(ready) {
  sending = true;
  let sent = 0;
  try {
    for (const post of ready) {
      // Drop it from the queue before sending: a post that fails is reported
      // as failed, never retried in a loop that could publish it twice.
      queue = queue.filter((p) => p.id !== post.id);
      const results = await hooks.send(post.items);
      sent += results.filter((r) => r.ok).length;
      hooks.notify({ type: "sent", postId: post.id, results, at: new Date().toISOString() });
    }
    lastRun = new Date().toISOString();
  } finally {
    sending = false;
  }
  return { sent };
}

function summary() {
  const next = queue
    .map((p) => new Date(p.scheduledAt))
    .filter((d) => d.getTime() > Date.now())
    .sort((a, b) => a - b)[0];
  return {
    queued: queue.length,
    overdue: due().length,
    nextAt: next ? next.toISOString() : null,
    lastRun,
    label: queue.length
      ? `${queue.length} queued${next ? ` · next ${next.toLocaleTimeString()}` : ""}`
      : "Nothing scheduled here",
  };
}

module.exports = { start, stop, setQueue, runNow, summary };
