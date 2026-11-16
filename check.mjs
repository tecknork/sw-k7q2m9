// Scheduled availability check.
// Everything site-specific lives in the WATCH_CONFIG secret (single-line JSON):
//   { "clubUrl": "...", "tenantId": "...", "apiPath": "/...{tenant}...{date}...", "courts": { "<id>": "<name>" } }
// Optional secret SLACK_WEBHOOK_URL: where alerts go. Without it the run only logs.
// This script never books anything. It only reads availability.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TZ = 'Europe/Berlin';
const DAYS_AHEAD = 17; // today + 16 more days
const MIN_DURATION = 90;
const SWEET = { startMin: '18:00', startMax: '18:30', endMax: '20:00' };
const STATE_PATH = fileURLToPath(new URL('./reported.json', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function localToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now); // YYYY-MM-DD
}

export function dateList(today, n) {
  const [y, m, d] = today.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
  return out.reverse(); // furthest date first
}

const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const fmtWeekday = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });
const fmtDayNum = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, month: 'short' });

// The site reports start times in UTC; convert to local club time.
export function toLocal(startDate, startTime, duration) {
  const start = new Date(`${startDate}T${startTime}Z`);
  const end = new Date(start.getTime() + duration * 60000);
  return {
    day: fmtDay.format(start),
    label: `${fmtWeekday.format(start)} ${fmtDayNum.format(start)} ${fmtMonth.format(start)}`,
    start: fmtTime.format(start),
    end: fmtTime.format(end),
  };
}

export function isSweet(start, end) {
  return start >= SWEET.startMin && start <= SWEET.startMax && end > start && end <= SWEET.endMax;
}

function price(p) {
  const m = /^(\d+(?:[.,]\d+)?)\s*EUR$/.exec(String(p ?? '').trim());
  return m ? `€${m[1]}` : String(p ?? '?');
}

// dataByDate: { 'YYYY-MM-DD': [ { resource_id, start_date, slots: [ { start_time, duration, price } ] } ] }
export function findings(dataByDate, courts = {}) {
  const out = [];
  for (const list of Object.values(dataByDate)) {
    for (const court of list) {
      for (const s of court.slots ?? []) {
        if (!(s.duration >= MIN_DURATION)) continue;
        const t = toLocal(court.start_date, s.start_time, s.duration);
        const name = courts[court.resource_id] ?? `Court ${String(court.resource_id).slice(0, 4)}`;
        out.push({
          key: `${t.day}|${t.start}|${name}|${s.duration}`,
          day: t.day,
          label: t.label,
          start: t.start,
          end: t.end,
          court: name,
          duration: s.duration,
          price: price(s.price),
          sweet: isSweet(t.start, t.end),
        });
      }
    }
  }
  out.sort((a, b) => Number(b.sweet) - Number(a.sweet) || a.day.localeCompare(b.day) || a.start.localeCompare(b.start) || a.court.localeCompare(b.court) || a.duration - b.duration);
  return out;
}

export function line(f) {
  return `${f.sweet ? '⭐ ' : ''}${f.label} · ${f.start}–${f.end} · ${f.court} · ${f.duration} min · ${f.price} · sweet spot: ${f.sweet ? 'YES' : 'no'}`;
}

// state: { key: { sent: boolean } }. Returns what to announce and the next state.
export function plan(state, current, today, canSend) {
  const next = {};
  for (const [k, v] of Object.entries(state)) if (k.slice(0, 10) >= today) next[k] = v; // drop past dates
  const fresh = current.filter((f) => !(f.key in next));
  const toSend = canSend ? current.filter((f) => !next[f.key]?.sent) : [];
  for (const f of current) if (!(f.key in next)) next[f.key] = { sent: false };
  return { next, fresh, toSend };
}

function makeRedactor(cfg) {
  const parts = [];
  try {
    const u = new URL(cfg.clubUrl);
    parts.push(cfg.clubUrl, u.host, u.pathname);
  } catch {}
  if (cfg.tenantId) parts.push(cfg.tenantId);
  return (text) => parts.filter((p) => p && p.length > 3).reduce((t, p) => t.split(p).join('***'), String(text));
}

async function collect(cfg, dates, redact) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ locale: 'en-GB', timezoneId: TZ });
    const page = await context.newPage();

    let loaded = false;
    let last = 'no response';
    for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
      try {
        const resp = await page.goto(cfg.clubUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        last = resp ? `HTTP ${resp.status()}` : 'no response';
        loaded = !!resp && resp.status() < 400;
      } catch (e) {
        last = redact(e.message).split('\n')[0];
      }
      if (!loaded) await sleep(3000 * attempt);
    }
    if (!loaded) throw new Error(`page did not load after 3 tries (${last})`);

    const results = {};
    const failures = [];
    for (const date of dates) {
      const path = cfg.apiPath.replace('{tenant}', cfg.tenantId).replace('{date}', date);
      let info = { status: 0, body: null };
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        info = await page.evaluate(async (p) => {
          try {
            const r = await fetch(p);
            let body = null;
            try { body = await r.json(); } catch {}
            return { status: r.status, body };
          } catch (e) {
            return { status: 0, body: null };
          }
        }, path);
        ok = info.status === 200 && Array.isArray(info.body);
        if (!ok) await sleep(1500 * attempt);
      }
      if (ok) results[date] = info.body;
      else failures.push(`${date} (HTTP ${info.status})`);
      await sleep(150);
    }
    return { results, failures };
  } finally {
    await browser.close();
  }
}

async function sendSlack(webhook, text) {
  const r = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error(`alert channel answered HTTP ${r.status}`);
}

async function main() {
  if (!process.env.WATCH_CONFIG) {
    console.log('::error::WATCH_CONFIG secret is missing.');
    process.exit(1);
  }
  const cfg = JSON.parse(process.env.WATCH_CONFIG);
  const redact = makeRedactor(cfg);
  const webhook = process.env.SLACK_WEBHOOK_URL || '';
  const today = localToday();
  const dates = dateList(today, DAYS_AHEAD);

  let collected;
  try {
    collected = await collect(cfg, dates, redact);
  } catch (e) {
    console.log(`::error::Check failed: ${redact(e.message).split('\n')[0]}`);
    process.exit(1);
  }
  const { results, failures } = collected;
  const okDays = Object.keys(results).length;
  console.log(`Checked ${dates.length} days (${dates[dates.length - 1]} to ${dates[0]}): ${okDays} answered, ${failures.length} failed.`);
  if (failures.length) console.log(`::warning::No answer for: ${failures.join(', ')}`);
  if (okDays === 0) {
    console.log('::error::No day answered.');
    process.exit(1);
  }

  const current = findings(results, cfg.courts);
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8') || '{}') : {};
  const { next, fresh, toSend } = plan(state, current, today, !!webhook);

  console.log(`Slots of ${MIN_DURATION}+ min right now: ${current.length}. New since last run: ${fresh.length}.`);
  for (const f of fresh) console.log('  NEW  ' + line(f));

  let failed = false;
  if (webhook && toSend.length) {
    const text = `🎾 ${toSend.length} new ${MIN_DURATION}+ min slot${toSend.length === 1 ? '' : 's'}\n` + toSend.map(line).join('\n') + `\n${cfg.clubUrl}`;
    try {
      await sendSlack(webhook, text);
      for (const f of toSend) next[f.key] = { sent: true };
      console.log(`Alert sent for ${toSend.length} slot(s).`);
    } catch (e) {
      console.log(`::error::Alert not sent: ${redact(e.message).split('\n')[0]}`);
      failed = true;
    }
  } else if (!webhook) {
    console.log('No alert channel set (SLACK_WEBHOOK_URL), so nothing was sent. Unsent slots are kept and go out once it is set.');
  }

  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(STATE_PATH, JSON.stringify(sorted, null, 1) + '\n');
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.log(`::error::Unexpected failure: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`);
    process.exit(1);
  });
}
