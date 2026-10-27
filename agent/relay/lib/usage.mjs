// pi-relay: Token usage, cost and compactions read incrementally from worker Pi session files.

import fs from 'node:fs';
import { state } from './runtime.mjs';

// Token usage, cost and compactions from worker Pi session files. Files are read incrementally
// (only bytes added since the last read), so the live console line stays cheap even for huge sessions.
export const zeroUsage = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, compactions: 0 });

export const sessionCache = new Map(); // path -> { offset, carry: Buffer, totals }

export function addSessionLine(totals, line) {
  if (!line.includes('"compaction"') && !line.includes('"usage"')) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === 'compaction') totals.compactions++;
  const m = e.message;
  if (e.type !== 'message' || m?.role !== 'assistant' || !m.usage) return;
  totals.turns++;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) totals[k] += m.usage[k] ?? 0;
  totals.costUsd += m.usage.cost?.total ?? 0;
}

export function sessionTotals(file) {
  if (!file || !fs.existsSync(file)) return null;
  let c = sessionCache.get(file);
  const size = fs.statSync(file).size;
  if (!c || size < c.offset) { c = { offset: 0, carry: Buffer.alloc(0), totals: zeroUsage() }; sessionCache.set(file, c); }
  if (size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(Math.min(8 << 20, size - c.offset));
      while (c.offset < size) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - c.offset), c.offset);
        if (n <= 0) break;
        c.offset += n;
        const buf = Buffer.concat([c.carry, chunk.subarray(0, n)]);
        const end = buf.lastIndexOf(10); // last newline: keep any partial line for next time
        if (end < 0) { c.carry = buf; continue; }
        for (const line of buf.subarray(0, end).toString('utf8').split('\n')) addSessionLine(c.totals, line);
        c.carry = Buffer.from(buf.subarray(end + 1));
      }
    } finally { fs.closeSync(fd); }
  }
  return { ...c.totals };
}

// Usage of the pending step so far: session totals now minus the totals when the step was sent.
export function stepUsage(p) {
  const session = state.cur?.agents[p.role]?.session;
  const nowTotals = sessionTotals(session);
  if (!nowTotals) return null;
  const start = p.startUsage?.session === session ? p.startUsage.totals : null;
  const d = zeroUsage();
  for (const k of Object.keys(d)) d[k] = nowTotals[k] - (start?.[k] ?? 0);
  d.costUsd = Math.round(d.costUsd * 10000) / 10000;
  return d;
}
