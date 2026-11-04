'use strict';
// archwhere bridge: lets a local CLI agent (Kiro, or anything that prints an answer) reply to board
// threads. It polls the repo's issues and issue comments for a mention ("@kiro") from allowed people,
// runs the CLI once per mention in a read-only checkout, and posts the answer back as a comment.
// One job at a time; a persisted cursor + seen-set means restarts never answer twice. Zero dependencies.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { hasMention, componentFromLabel } = require('./rail');

const MAX_REPLY = 60000;
const BRIDGE_TAG = '(via archwhere bridge)';

// ---------- pure helpers (unit-tested) ----------

/** Strip ANSI escape sequences (colours, cursor moves, OSC links) and stray carriage returns. */
function stripAnsi(s) {
  return String(s || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, '')
    .replace(/\r(?!\n)/g, '');
}

/** Cap at `max` chars, keeping the start and saying how much was cut. */
function capLength(s, max = MAX_REPLY) {
  s = String(s || '');
  if (s.length <= max) return s;
  const note = `\n\n… (truncated ${s.length - max} characters)`;
  return s.slice(0, Math.max(0, max - note.length)) + note;
}

/** "@alice" in CLI output would ping people (and could summon another agent); break the handle. */
function defuseMentions(s) {
  return String(s || '').replace(/(^|[^\w@/.`-])@([A-Za-z0-9][\w-]*)/g, '$1@​$2');
}

/** Split a command line into argv, honouring '…' and "…" quotes. No shell, no expansion. */
function splitCommand(cmd) {
  const out = []; let cur = ''; let q = null; let any = false;
  for (const ch of String(cmd || '')) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (q) throw new Error('unterminated quote in --cmd');
  if (cur || any) out.push(cur);
  return out;
}

const header = name => `🤖 **${name}** ${BRIDGE_TAG}`;
const isBot = u => !!u && (u.type === 'Bot' || /\[bot\]$/i.test(u.login || ''));
const isBridgeReply = body => String(body || '').includes(BRIDGE_TAG) && /^\s*🤖/.test(String(body || ''));

/**
 * Should this item trigger a job? Needs the mention, an allowed human author, and must not be a bridge
 * reply (the bridge usually posts with the owner's own token, so its replies are spotted by the header).
 */
function shouldAnswer(item, { mention, allow }) {
  if (!item || !item.user) return false;
  if (isBot(item.user)) return false;
  if (isBridgeReply(item.body)) return false;
  const ok = (allow || []).map(x => x.toLowerCase());
  if (!ok.includes(String(item.user.login || '').toLowerCase())) return false;
  return hasMention(item.body, mention);
}

/** Default allow-list: the repo owner plus --allow logins. */
function allowList(owner, extra) {
  const more = (Array.isArray(extra) ? extra : String(extra || '').split(','));
  return [...new Set([owner, ...more].map(s => String(s || '').trim()).filter(Boolean))];
}

const trim = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + ' …' : s; };

/** The prompt for the CLI: thread, recent conversation, component, and the ground rules. */
function buildPrompt({ repo, issue, comments = [], trigger, component, name = 'Kiro' }) {
  const recent = comments.slice(-10).map(c => `--- ${c.user && c.user.login || '?'} (${c.created_at || ''}):\n${trim(c.body, 2000)}`);
  return [
    `You are ${name}, answering a question on a GitHub thread in ${repo} from archwhere mission control.`,
    `Answer about this repository's code, which is checked out in your current directory.`,
    `Rules: read-only — do not modify files, run builds, install anything or push. Be concise and use plain English.`,
    `Point to file paths (and line numbers when useful). If you are unsure, say so. Do not @mention anyone.`,
    '',
    `Thread #${issue.number}: ${issue.title}`,
    component ? `Component: ${component} (see arch/architecture.json)` : '',
    '',
    'Opening post:',
    trim(issue.body, 4000) || '(empty)',
    '',
    recent.length ? 'Recent comments (oldest first):\n' + recent.join('\n\n') : 'No comments yet.',
    '',
    'The message you are answering:',
    trim(trigger.body, 4000)
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

/** Reply body: header, the cleaned CLI answer, capped. */
function formatReply(name, output) {
  const clean = defuseMentions(stripAnsi(output)).trim() || '(no output)';
  return capLength(header(name) + '\n\n' + clean);
}

function formatError(name, err) {
  const why = err && err.code === 'TIMEOUT' ? 'it took too long' : 'the agent command failed';
  return header(name) + `\n\nSorry, I couldn't answer this one (${why}). The owner can check the bridge log.`;
}

// ---------- state ----------

function defaultStatePath(owner, repo, mention) {
  return path.join(os.homedir(), '.archwhere', `bridge-${owner}-${repo}-${mention.replace(/\W/g, '')}.json`);
}

function loadState(file, { now = Date.now(), lookbackMs = 10 * 60000 } = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { since: s.since, seen: Array.isArray(s.seen) ? s.seen : [] };
  } catch {
    return { since: new Date(now - lookbackMs).toISOString(), seen: [] };
  }
}

function saveState(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ since: st.since, seen: st.seen.slice(-2000) }, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- running the CLI ----------

/** Default runner: execFile (no shell), args array, timeout. Resolves stdout; rejects with code TIMEOUT on timeout. */
function execRunner(file, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed || err.signal === 'SIGKILL') { const e = new Error('timed out'); e.code = 'TIMEOUT'; return reject(e); }
        err.stderr = stderr; return reject(err);
      }
      resolve(stdout);
    });
  });
}

/** Run `cmd` + [prompt] via the runner, enforcing the timeout even if the runner ignores it. */
async function runAgent(cmd, prompt, { cwd, timeoutMs = 300000, runner = execRunner } = {}) {
  const argv = splitCommand(cmd);
  if (!argv.length) throw new Error('--cmd is empty');
  const [file, ...args] = argv;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error('timed out'); e.code = 'TIMEOUT'; reject(e); }, timeoutMs);
  });
  try { return await Promise.race([runner(file, [...args, prompt], { cwd, timeoutMs }), deadline]); }
  finally { clearTimeout(timer); }
}

// ---------- the bridge ----------

/**
 * makeBridge({ gh, owner, repo, mention, cmd, ... }) -> { pollOnce, drain, runOnce, start, state }
 * `gh(path, opts)` is the GitHub client (see lib/gh.js); tests inject a stub.
 */
function makeBridge(o) {
  const mention = o.mention.startsWith('@') ? o.mention : '@' + o.mention;
  const name = o.name || mention.slice(1).replace(/^./, c => c.toUpperCase());
  const allow = allowList(o.owner, o.allow);
  const statePath = o.statePath || defaultStatePath(o.owner, o.repo, mention);
  const log = o.log || (line => console.log(new Date().toISOString() + ' ' + line));
  const now = o.now || (() => Date.now());
  const st = loadState(statePath, { now: now(), lookbackMs: o.lookbackMs });
  const seen = new Set(st.seen);
  const queue = [];
  const R = p => `/repos/${o.owner}/${o.repo}${p}`;
  let busy = false;

  const remember = key => { seen.add(key); st.seen.push(key); };
  const persist = () => saveState(statePath, st);

  async function pollOnce() {
    const since = st.since;
    const q = `since=${encodeURIComponent(since)}&per_page=100`;
    const [comments, issues] = await Promise.all([
      o.gh(R(`/issues/comments?${q}&sort=updated&direction=asc`)),
      o.gh(R(`/issues?${q}&state=open&sort=updated&direction=asc`))
    ]);
    let maxAt = since;
    const bump = t => { if (t && t > maxAt) maxAt = t; };
    const found = [];
    for (const c of comments || []) {
      bump(c.updated_at || c.created_at);
      const key = 'c:' + c.id;
      if (seen.has(key) || queue.some(j => j.key === key)) continue;
      if ((c.created_at || '') < since) continue;            // an old comment that was merely edited
      const number = parseInt(String(c.issue_url || '').split('/').pop(), 10);
      if (!number) continue;
      if (shouldAnswer(c, { mention, allow })) found.push({ key, number, trigger: c });
      else remember(key);
    }
    for (const is of issues || []) {
      bump(is.updated_at || is.created_at);
      const key = 'i:' + is.number;
      if (seen.has(key) || queue.some(j => j.key === key)) continue;
      if ((is.created_at || '') < since) continue;           // only brand-new threads; comments cover the rest
      if (shouldAnswer(is, { mention, allow })) found.push({ key, number: is.number, trigger: is, isIssue: true });
      else remember(key);
    }
    queue.push(...found);
    st.since = maxAt;
    persist();
    return found.length;
  }

  async function handle(job) {
    const t0 = now();
    let status = 'ok';
    try {
      const [issue, comments] = await Promise.all([
        job.isIssue ? job.trigger : o.gh(R(`/issues/${job.number}`)),
        o.gh(R(`/issues/${job.number}/comments?per_page=100`))
      ]);
      const before = (comments || []).filter(c => c.id !== job.trigger.id);
      const component = (issue.labels || []).map(l => componentFromLabel(typeof l === 'string' ? l : l.name)).find(Boolean) || null;
      const prompt = buildPrompt({ repo: `${o.owner}/${o.repo}`, issue, comments: job.isIssue ? [] : before, trigger: job.trigger, component, name });
      let body;
      try {
        body = formatReply(name, await runAgent(o.cmd, prompt, { cwd: o.cwd, timeoutMs: o.timeoutMs, runner: o.runner }));
      } catch (e) {
        status = e.code === 'TIMEOUT' ? 'timeout' : 'error: ' + String(e.message || e).split('\n')[0].slice(0, 120);
        body = formatError(name, e);
      }
      await o.gh(R(`/issues/${job.number}/comments`), { method: 'POST', body: JSON.stringify({ body }) });
    } catch (e) {
      status = 'post-failed: ' + String(e.message || e).slice(0, 120);
    }
    remember(job.key);
    persist();
    log(`#${job.number} ${job.key} by ${job.trigger.user.login} -> ${status} (${Math.round((now() - t0) / 1000)}s)`);
    return status;
  }

  async function drain() {
    if (busy) return [];
    busy = true;
    const done = [];
    try { while (queue.length) done.push(await handle(queue.shift())); }
    finally { busy = false; }
    return done;
  }

  async function runOnce() { await pollOnce(); return drain(); }

  function start() {
    const every = (o.intervalSec || 30) * 1000;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try { await runOnce(); } catch (e) { log('poll failed: ' + String(e.message || e).slice(0, 200)); }
      if (!stopped) setTimeout(tick, every);
    };
    tick();
    return () => { stopped = true; };
  }

  return { pollOnce, drain, runOnce, start, state: st, queue, allow, name, mention, statePath };
}

/** Parse `archwhere bridge` flags. */
function parseBridgeArgs(args) {
  const val = f => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
  return {
    repo: val('--repo'), mention: val('--mention'), cmd: val('--cmd'), name: val('--name'),
    cwd: val('--cwd'), interval: parseInt(val('--interval') || '30', 10),
    timeout: parseInt(val('--timeout') || '300', 10), allow: val('--allow') || '',
    state: val('--state'), once: args.includes('--once')
  };
}

module.exports = {
  stripAnsi, capLength, defuseMentions, splitCommand, shouldAnswer, allowList, buildPrompt,
  formatReply, formatError, loadState, saveState, execRunner, runAgent, makeBridge, parseBridgeArgs,
  defaultStatePath, header, MAX_REPLY
};
