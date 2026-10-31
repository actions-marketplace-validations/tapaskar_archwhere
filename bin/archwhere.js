#!/usr/bin/env node
'use strict';
// archwhere — put your AI coding agents' work on the architecture map.
// https://github.com/tapaskar/archwhere  (MIT)

const fs = require('fs');
const path = require('path');
const W = require('../lib/where');

const USAGE = `
archwhere — which architecture component does this change touch?

  archwhere [map] [--base REF] [--format text|md|mermaid|html]   map a diff
  archwhere doc  [--out ARCHITECTURE.md]                         full map doc
  archwhere check                                                model sanity (CI-friendly)
  archwhere ir   [--out arch/build]                              Archify IR diagrams
  archwhere mission [--port 4610]                                mission-control UI
  archwhere init                                                 scaffold model + workflows

Common: --arch <path to architecture.json> · env ARCHWHERE_MODEL
Mission env: GITHUB_TOKEN (or gh auth token) · AGENT_MENTION · RUNTIME_URL/RUNTIME_BASIC
`;

function arg(args, flag) { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; }

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'map';
  const root = process.cwd();
  const archPath = arg(args, '--arch');

  if (cmd === 'help' || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE); return;
  }

  if (cmd === 'init') return init(root);

  if (cmd === 'mission') {
    const { makeServer } = require('../lib/mission');
    const port = parseInt(arg(args, '--port') || process.env.ARCHWHERE_PORT || '4610', 10);
    const { server, owner, repo, token } = makeServer({ root, arch: archPath });
    server.listen(port, '127.0.0.1', () => {
      console.log(`archwhere mission control: http://localhost:${port}   repo ${owner}/${repo}${token ? '' : '   (no GitHub token found)'}`);
    });
    return;
  }

  const arch = W.loadArch(root, archPath);

  if (cmd === 'doc') {
    const doc = W.renderFullMd(arch);
    const out = arg(args, '--out');
    if (out) { fs.writeFileSync(out, doc); console.log('wrote', out); }
    else process.stdout.write(doc);
    return;
  }

  if (cmd === 'check') {
    const { execFileSync } = require('child_process');
    const errors = [];
    const kinds = new Set(arch.kinds || ['core', 'security', 'feature', 'infra', 'product', 'ops', 'docs']);
    let tracked = [];
    try { tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch {}
    for (const [id, c] of Object.entries(arch.components)) {
      if (!/^[a-z0-9-]+$/.test(id)) errors.push(`${id}: id must be kebab-case`);
      if (!c.name) errors.push(`${id}: missing name`);
      if (!kinds.has(c.kind)) errors.push(`${id}: unknown kind "${c.kind}"`);
      if (!Array.isArray(c.paths) || !c.paths.length) errors.push(`${id}: needs path globs`);
      for (const d of c.deps || []) if (!arch.components[d]) errors.push(`${id}: dep "${d}" does not exist`);
      if (tracked.length && c.paths && !tracked.some(f => c.paths.some(g => W.globToRe(g).test(f)))) {
        errors.push(`${id}: no tracked file matches its globs — stale map`);
      }
    }
    if (tracked.length) {
      const { unmapped } = W.mapFiles(arch, tracked);
      if (unmapped.length) errors.push(`unmapped tracked files (${unmapped.length}): ${unmapped.slice(0, 10).join(', ')}${unmapped.length > 10 ? ', …' : ''}`);
    }
    for (const [fid, f] of Object.entries(arch.flows || {})) {
      for (const s of f.steps || []) {
        if (!arch.components[s.from] || !arch.components[s.to]) errors.push(`flow ${fid}: unknown component in step`);
        if (!s.label) errors.push(`flow ${fid}: step needs a label`);
      }
    }
    if (errors.length) { for (const e of errors) console.error('✗ ' + e); process.exit(1); }
    console.log(`✓ model ok: ${Object.keys(arch.components).length} components, ${Object.keys(arch.flows || {}).length} flows, every tracked file mapped`);
    return;
  }

  if (cmd === 'ir') {
    const { emit } = require('../lib/archify');
    const outDir = arg(args, '--out') || path.join(path.dirname(arch.__path), 'build');
    for (const p of emit(arch, outDir)) console.log('wrote', path.relative(root, p));
    console.log('\nRender with Archify (https://github.com/tt-a1i/archify):');
    console.log('  node <archify>/archify/bin/archify.mjs deliver architecture <file> <out.html> --quality showcase --open');
    return;
  }

  // default: map
  const base = arg(args, '--base');
  const format = arg(args, '--format') || 'text';
  if (args.includes('--full')) {
    process.stdout.write(format === 'mermaid' ? W.mermaid(arch, []) + '\n' : W.renderFullMd(arch));
    return;
  }
  const res = W.mapFiles(arch, W.changedFiles(root, base));
  const flags = W.collectFlags(arch, root, base, res.byComponent);
  if (format === 'mermaid') process.stdout.write(W.mermaid(arch, [...res.byComponent.keys()]) + '\n');
  else if (format === 'md') process.stdout.write(W.renderMd(arch, res, flags) + '\n');
  else if (format === 'html') process.stdout.write(W.renderHtml(arch, res, flags, { base }) + '\n');
  else process.stdout.write(W.renderText(arch, res, flags) + '\n');
}

function init(root) {
  const dir = path.join(root, 'arch');
  fs.mkdirSync(dir, { recursive: true });
  const modelPath = path.join(dir, 'architecture.json');
  if (fs.existsSync(modelPath)) { console.log('arch/architecture.json already exists — not touching it.'); }
  else {
    const starter = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'meridian', 'architecture.json'), 'utf8'));
    starter.system = path.basename(root);
    starter.note = 'STARTER MODEL — replace the example components with your real ones. ' + starter.note;
    fs.writeFileSync(modelPath, JSON.stringify(starter, null, 2) + '\n');
    console.log('wrote arch/architecture.json (starter — replace the example components)');
  }
  const wfDir = path.join(root, '.github', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  for (const t of ['archwhere.yml', 'agent-reply.yml', 'agent-webhook.yml']) {
    const dest = path.join(wfDir, t);
    if (fs.existsSync(dest)) { console.log(`.github/workflows/${t} exists — skipped`); continue; }
    fs.copyFileSync(path.join(__dirname, '..', 'templates', t), dest);
    console.log('wrote .github/workflows/' + t);
  }
  console.log(`
Next — let your coding agent write the real model. Paste this to it:

  Survey this repository and replace the starter arch/architecture.json with
  the real model: 10–20 declared components (not an import graph), each with
  name, kind (core/security/feature/infra/product/ops/docs), description,
  the file globs it owns, deps, and watch patterns for review-sensitive code.
  Add 2–3 "flows" for the main user journeys. Every tracked file must map to
  a component ("npx archwhere check" must pass). Then run
  "npx archwhere doc --out ARCHITECTURE.md" and commit both.
`);
}

main();
