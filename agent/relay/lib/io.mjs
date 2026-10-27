// pi-relay: The real outside world: every process, terminal and network access of the relay.

import { spawnSync } from 'node:child_process';

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (r.error) throw r.error;
  return r;
}

export const realIo = {
  herdr: (args) => run('herdr', args),
  git: (args, cwd) => run('git', args, { cwd }),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  notify: (title, body) => run('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]),
  write: (text) => process.stdout.write(text),
  isTTY: () => Boolean(process.stdout.isTTY),
  columns: () => {
    // The relay blocks in synchronous calls, so Node never processes SIGWINCH and process.stdout.columns
    // goes stale after a resize; process.stdout.getWindowSize() returns the same cached value. Read the
    // terminal device through the TTY handle instead (a synchronous ioctl, as Node itself does on SIGWINCH).
    try {
      const handle = process.stdout.isTTY ? process.stdout._handle : null;
      if (handle?.getWindowSize) {
        const size = [0, 0];
        if (!handle.getWindowSize(size) && size[0] > 0) return size[0];
      }
    } catch { /* fall back below */ }
    return process.stdout.columns || 100;
  },
  env: process.env,
  relayHome: null, // null: the directory of this script (config.json)
  cwd: () => process.cwd(),
  pid: process.pid,
  processAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  onExit: (fn) => process.on('exit', fn),
  fetchUsage: () => {
    const tok = run('pi', ['auth', 'print-bearer-token', '--provider', 'anthropic']);
    if (tok.status !== 0) return { status: 0 };
    const r = run(process.execPath, ['-e', USAGE_SNIPPET], { input: tok.stdout.trim() });
    try { return JSON.parse(r.stdout); } catch { return { status: 0 }; }
  },
};

export const USAGE_SNIPPET = `let t='';process.stdin.on('data',d=>t+=d).on('end',async()=>{try{
  const r=await fetch('https://api.anthropic.com/api/oauth/usage',{headers:{Authorization:'Bearer '+t.trim(),
    'anthropic-beta':'oauth-2025-04-20',Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  console.log(JSON.stringify({status:r.status,body:r.ok?await r.json():null}));
}catch(e){console.log(JSON.stringify({status:0,error:String(e)}))}});`;
// The usage endpoint is itself rate-limited (every Pi session's quota footer also polls it), so
// readings are shared across relays and restarts through a small file, and 429s are retried.
