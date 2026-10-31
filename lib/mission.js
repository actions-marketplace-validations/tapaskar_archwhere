'use strict';
// archwhere mission control: the architecture map as a conversation surface.
// Reads GitHub; writes only when the operator acts (new thread, comment, merge).
// Zero dependencies. See README "Mission control".

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const W = require('./where');
const L = require('./rail');

function makeServer(opts = {}) {
  const ROOT = opts.root || process.cwd();
  const GH = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');

  const arch0 = W.loadArch(ROOT, opts.arch);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(arch0.__path), 'mission.config.json'), 'utf8')); } catch { /* defaults */ }
  const MENTION = L.resolveAgentMention(process.env, cfg);

  function token() {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); }
    catch { return ''; }
  }
  const TOKEN = token();
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' });
  const { owner, repo } = L.parseRepo(remote);
  const API = p => `${GH}/repos/${owner}/${repo}${p}`;

  async function gh(url, o = {}) {
    const res = await fetch(url, {
      ...o,
      headers: {
        'Accept': 'application/vnd.github+json', 'User-Agent': 'archwhere',
        ...(TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {}),
        ...(o.body ? { 'Content-Type': 'application/json' } : {}), ...(o.headers || {})
      }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status} on ${url.replace(GH, '')}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  let viewer = null;
  async function whoami() {
    if (viewer !== null) return viewer;
    try { viewer = (await gh(`${GH}/user`)).login; } catch { viewer = ''; }
    return viewer;
  }

  let cache = { at: 0, data: null };
  async function assembleState() {
    const arch = W.loadArch(ROOT, opts.arch);
    const [prsRaw, issuesRaw] = await Promise.all([
      gh(API('/pulls?state=open&per_page=50')),
      gh(API('/issues?state=open&per_page=100'))
    ]);
    const issues = issuesRaw.filter(i => !i.pull_request);
    const prs = await Promise.all(prsRaw.slice(0, 20).map(async p => {
      const [files, checks] = await Promise.all([
        gh(API(`/pulls/${p.number}/files?per_page=100`)).catch(() => []),
        gh(API(`/commits/${p.head.sha}/check-runs?per_page=50`)).catch(() => ({ check_runs: [] }))
      ]);
      return {
        number: p.number, title: p.title, labels: p.labels, draft: p.draft,
        html_url: p.html_url, comments: p.comments, review_comments: p.review_comments,
        mergeable: p.mergeable, mergeable_state: p.mergeable_state,
        branch: p.head.ref, files: files.map(f => f.filename),
        checkRuns: (checks.check_runs || []).map(r => ({ status: r.status, conclusion: r.conclusion }))
      };
    }));
    const rail = L.buildRail(arch, { prs, issues });
    const badges = L.componentBadges(arch, { prs, issues }, rail);
    let local = { components: [], unmapped: [] };
    try {
      const res = W.mapFiles(arch, W.changedFiles(ROOT, null));
      local = { components: [...res.byComponent.keys()], unmapped: res.unmapped };
    } catch { /* not a git checkout */ }
    return {
      generated: new Date().toISOString(), repo: `${owner}/${repo}`, rail, badges, local,
      prs: prs.map(p => ({ ...p, components: L.prComponents(arch, p) })),
      threads: issues
        .map(i => ({
          number: i.number, title: i.title, comments: i.comments, url: i.html_url,
          components: (i.labels || []).map(l => L.componentFromLabel(l.name)).filter(Boolean),
          labels: (i.labels || []).map(l => l.name)
        }))
        .filter(t => t.components.length || t.labels.some(l => ['security', 'blocked', 'needs-owner'].includes(l)))
    };
  }
  async function state() {
    if (Date.now() - cache.at < 20000 && cache.data) return cache.data;
    cache = { at: Date.now(), data: await assembleState() };
    return cache.data;
  }

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const readBody = req => new Promise((ok, no) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) no(new Error('body too large')); });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
  });
  async function ensureLabel(nameL) {
    try {
      await gh(API('/labels'), { method: 'POST', body: JSON.stringify({ name: nameL, color: '0F7A5C', description: 'archwhere component thread' }) });
    } catch (e) { if (!String(e.message).includes('422')) throw e; }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && u.pathname === '/') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, '..', 'ui', 'mission.html'), 'utf8'), 'text/html');
      }
      if (req.method === 'GET' && u.pathname === '/api/model') {
        const arch = W.loadArch(ROOT, opts.arch);
        return send(res, 200, {
          system: W.systemName(arch), components: arch.components,
          lanes: W.lanesOf(arch), laneTitles: W.laneTitles(arch), flows: arch.flows || {},
          repo: `${owner}/${repo}`, viewer: await whoami(), mention: MENTION
        });
      }
      if (req.method === 'GET' && u.pathname === '/api/state') return send(res, 200, await state());
      if (req.method === 'GET' && u.pathname === '/api/thread') {
        const n = parseInt(u.searchParams.get('number'), 10);
        const [issue, comments] = await Promise.all([
          gh(API(`/issues/${n}`)), gh(API(`/issues/${n}/comments?per_page=100`))
        ]);
        return send(res, 200, {
          number: n, title: issue.title, state: issue.state, url: issue.html_url,
          body: issue.body || '', user: issue.user && issue.user.login,
          comments: comments.map(c => ({ user: c.user.login, at: c.created_at, body: c.body }))
        });
      }
      if (req.method === 'POST' && u.pathname === '/api/thread') {
        const { component, title, body } = await readBody(req);
        const arch = W.loadArch(ROOT, opts.arch);
        if (!arch.components[component]) return send(res, 400, { error: 'unknown component' });
        const label = L.threadLabel(component);
        await ensureLabel(label);
        const fullBody = L.withSummon(body, MENTION,
          ' please investigate and reply in this thread. Component: `' + component + '` (see the architecture model).');
        const issue = await gh(API('/issues'), {
          method: 'POST', body: JSON.stringify({ title: `[${component}] ${title}`, body: fullBody, labels: [label] })
        });
        cache.at = 0;
        return send(res, 200, { number: issue.number, url: issue.html_url });
      }
      if (req.method === 'POST' && u.pathname === '/api/comment') {
        const { number, body } = await readBody(req);
        await gh(API(`/issues/${number}/comments`), { method: 'POST', body: JSON.stringify({ body: L.withSummon(body, MENTION) }) });
        cache.at = 0;
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u.pathname === '/api/merge') {
        const { number } = await readBody(req);
        const r = await gh(API(`/pulls/${number}/merge`), { method: 'PUT', body: JSON.stringify({ merge_method: 'merge' }) });
        cache.at = 0;
        return send(res, 200, { merged: !!r.merged, message: r.message || '' });
      }
      if (req.method === 'GET' && u.pathname === '/api/runtime') {
        const base = process.env.RUNTIME_URL || process.env.OBS_URL;
        if (!base) return send(res, 200, { available: false, reason: 'RUNTIME_URL not set' });
        const headers = {};
        const basic = process.env.RUNTIME_BASIC || process.env.OBS_BASIC;
        if (basic) headers.Authorization = 'Basic ' + Buffer.from(basic).toString('base64');
        try {
          const r = await fetch(base, { headers });
          if (!r.ok) throw new Error('runtime endpoint ' + r.status);
          return send(res, 200, { available: true, ...(await r.json()) });
        } catch (e) { return send(res, 200, { available: false, reason: String(e.message) }); }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });
  return { server, owner, repo, token: !!TOKEN };
}

module.exports = { makeServer };
