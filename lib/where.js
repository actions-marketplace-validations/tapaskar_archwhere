'use strict';
// archwhere core: load a declared architecture model, map changed files to
// components, render text / markdown / mermaid / html. Zero dependencies.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Locate the model: explicit/env wins, then arch/architecture.json, then ./architecture.json. */
function findModelPath(root, explicit) {
  const cands = [
    explicit, process.env.ARCHWHERE_MODEL,
    path.join(root, 'arch', 'architecture.json'),
    path.join(root, 'architecture.json')
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function loadArch(root, explicit) {
  const p = findModelPath(root, explicit);
  if (!p) throw new Error('no architecture model found (arch/architecture.json). Run: archwhere init');
  const arch = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!arch.components || typeof arch.components !== 'object') {
    throw new Error(p + ': missing "components"');
  }
  arch.__path = p;
  return arch;
}

const systemName = arch => arch.system || 'System';

const KIND_ORDER = ['product', 'core', 'security', 'feature', 'infra', 'ops', 'docs'];

/** Lanes: declared, else grouped by kind in a stable order. */
function lanesOf(arch) {
  if (Array.isArray(arch.lanes) && arch.lanes.length) return arch.lanes;
  const byKind = {};
  for (const [id, c] of Object.entries(arch.components)) (byKind[c.kind] = byKind[c.kind] || []).push(id);
  const order = [...KIND_ORDER, ...Object.keys(byKind).filter(k => !KIND_ORDER.includes(k))];
  return order.map(k => byKind[k]).filter(Boolean);
}

function laneTitles(arch) {
  const lanes = lanesOf(arch);
  if (Array.isArray(arch.laneTitles) && arch.laneTitles.length === lanes.length) return arch.laneTitles;
  return lanes.map(lane => {
    const kinds = [...new Set(lane.map(id => (arch.components[id] || {}).kind).filter(Boolean))];
    return kinds.join(' · ').toUpperCase();
  });
}

// ** crosses directories, * stays within one path segment.
function globToRe(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*');
  return new RegExp('^' + esc + '$');
}

function compileMatchers(arch) {
  const out = [];
  for (const [id, c] of Object.entries(arch.components)) {
    for (const g of c.paths || []) out.push({ id, glob: g, re: globToRe(g), len: g.length });
  }
  return out;
}

/** Longest matching glob wins, so a specific component beats a broad one. */
function mapFiles(arch, files) {
  const matchers = compileMatchers(arch);
  const byComponent = new Map();
  const unmapped = [];
  for (const f of files) {
    let best = null;
    for (const m of matchers) if (m.re.test(f) && (!best || m.len > best.len)) best = m;
    if (!best) { unmapped.push(f); continue; }
    if (!byComponent.has(best.id)) byComponent.set(best.id, []);
    byComponent.get(best.id).push(f);
  }
  return { byComponent, unmapped };
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function changedFiles(root, base) {
  const set = new Set();
  const add = out => out.split('\n').forEach(f => { if (f) set.add(f); });
  if (base) {
    add(git(root, ['diff', '--name-only', base + '...HEAD']));
  } else {
    add(git(root, ['diff', '--name-only', 'HEAD']));
    add(git(root, ['ls-files', '-o', '--exclude-standard']));
  }
  return [...set].sort();
}

function diffText(root, base, files) {
  try {
    return base
      ? git(root, ['diff', base + '...HEAD', '--', ...files])
      : git(root, ['diff', 'HEAD', '--', ...files]);
  } catch { return ''; }
}

/** Security components always flag; watch patterns run against the diff text. */
function collectFlags(arch, root, base, byComponent) {
  const flags = [];
  for (const [id, files] of byComponent) {
    const c = arch.components[id];
    if (c.kind === 'security') {
      flags.push(`**${c.name}** is a security component — review accordingly.`);
    }
    if (c.watch && c.watch.length) {
      const text = diffText(root, base, files);
      for (const w of c.watch) {
        if (new RegExp(w.pattern, 'i').test(text)) flags.push(`**${c.name}**: ${w.note}`);
      }
    }
  }
  return flags;
}

const KIND_STYLE = {
  core: 'fill:#E8EEF9,stroke:#2F4AC0,color:#1F2433',
  security: 'fill:#FDE8E4,stroke:#C2410C,color:#1F2433',
  feature: 'fill:#FFF4E0,stroke:#B45309,color:#1F2433',
  infra: 'fill:#EFEFEF,stroke:#595959,color:#1F2433',
  product: 'fill:#E3F2EC,stroke:#0F7A5C,color:#1F2433',
  ops: 'fill:#F3E8F9,stroke:#7E3FA0,color:#1F2433',
  docs: 'fill:#F7F7F7,stroke:#8A8A8A,color:#1F2433',
  other: 'fill:#F2F2EF,stroke:#777,color:#1F2433'
};

function mermaid(arch, touchedIds) {
  const touched = new Set(touchedIds || []);
  const L = ['flowchart LR'];
  for (const [id, c] of Object.entries(arch.components)) {
    const label = c.provider ? `${c.name}<br/><i>${c.provider}</i>` : c.name;
    L.push(`  ${id}["${label}"]`);
  }
  for (const [id, c] of Object.entries(arch.components)) {
    for (const d of c.deps || []) if (arch.components[d]) L.push(`  ${id} --> ${d}`);
  }
  for (const [k, style] of Object.entries(KIND_STYLE)) L.push(`  classDef ${k} ${style}`);
  L.push('  classDef touched fill:#F7B32B,stroke:#1F2433,stroke-width:3px,color:#1F2433');
  const byKind = {};
  for (const [id, c] of Object.entries(arch.components)) {
    if (touched.has(id)) continue;
    const k = KIND_STYLE[c.kind] ? c.kind : 'other';
    (byKind[k] = byKind[k] || []).push(id);
  }
  for (const [kind, ids] of Object.entries(byKind)) L.push(`  class ${ids.join(',')} ${kind}`);
  if (touched.size) L.push(`  class ${[...touched].join(',')} touched`);
  return L.join('\n');
}

function renderText(arch, res, flags) {
  const out = [];
  if (!res.byComponent.size && !res.unmapped.length) return 'No changes detected.';
  for (const [id, files] of res.byComponent) {
    const c = arch.components[id];
    out.push(`${c.name}  [${c.kind}]  — ${files.length} file${files.length === 1 ? '' : 's'}`);
    for (const f of files) out.push(`    ${f}`);
  }
  for (const f of flags) out.push(`! ${f.replace(/\*\*/g, '')}`);
  if (res.unmapped.length) out.push(`? unmapped (add to the model): ${res.unmapped.join(', ')}`);
  return out.join('\n');
}

function renderMd(arch, res, flags) {
  const out = ['<!-- archwhere -->', '### 🗺 Architecture impact', ''];
  if (!res.byComponent.size && !res.unmapped.length) {
    out.push('_No file changes detected._');
    return out.join('\n');
  }
  out.push('| Component | Kind | Files changed |', '|---|---|---|');
  for (const [id, files] of res.byComponent) {
    const c = arch.components[id];
    out.push(`| **${c.name}** | ${c.kind} | ${files.map(f => '`' + f + '`').join('<br>')} |`);
  }
  if (flags.length) { out.push('', '**Flags**', ''); for (const f of flags) out.push(`- ⚠ ${f}`); }
  if (res.unmapped.length) {
    out.push('', `**Unmapped files** — add them to a component in the model: ${res.unmapped.map(f => '`' + f + '`').join(', ')}`);
  }
  out.push('', '<details><summary>System map — touched components highlighted</summary>', '',
    '```mermaid', mermaid(arch, [...res.byComponent.keys()]), '```', '', '</details>');
  return out.join('\n');
}

function renderFullMd(arch) {
  const out = [
    `# ${systemName(arch)} — architecture map`, '',
    '_Generated by [archwhere](https://github.com/tapaskar/archwhere) from the declared model. Do not edit by hand._', '',
    '```mermaid', mermaid(arch, []), '```', '',
    '| Component | Kind | Provider | What it is | Owns |', '|---|---|---|---|---|'
  ];
  for (const c of Object.values(arch.components)) {
    out.push(`| **${c.name}** | ${c.kind} | ${c.provider || ''} | ${c.description || ''} | ${(c.paths || []).map(p => '`' + p + '`').join(' ')} |`);
  }
  const flows = Object.entries(arch.flows || {});
  if (flows.length) {
    out.push('', '## Process flows (dynamic views)', '', '| Flow | Actor | Path |', '|---|---|---|');
    for (const [, f] of flows) {
      const seq = [];
      for (const st of f.steps) {
        if (seq[seq.length - 1] !== st.from) seq.push(st.from);
        seq.push(st.to);
      }
      const names = seq.map(id => (arch.components[id] || { name: id }).name);
      out.push(`| **${f.name}** | ${f.actor || ''} | ${names.join(' → ')} |`);
    }
  }
  out.push('');
  return out.join('\n');
}


function escHtml(x) {
  return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const KIND_COLORS = {
  core: '#2F4AC0', security: '#C2410C', feature: '#B45309', infra: '#595959',
  product: '#0F7A5C', ops: '#7E3FA0', docs: '#8A8A8A'
};

/** Self-contained one-off page: diagram + touched-component cards. */
function renderHtml(arch, res, flags, meta) {
  const touched = [...res.byComponent.keys()];
  const mode = meta && meta.base ? `branch vs ${escHtml(meta.base)}` : 'working tree';
  const cards = touched.map(id => {
    const c = arch.components[id];
    const color = KIND_COLORS[c.kind] || '#595959';
    const files = res.byComponent.get(id).map(f => `<li><code>${escHtml(f)}</code></li>`).join('');
    const prov = c.provider ? ` <span style="color:#6b7180;font-weight:400">· ${escHtml(c.provider)}</span>` : '';
    return `<div class="card" style="border-left:6px solid ${color}"><div class="ch"><b>${escHtml(c.name)}${prov}</b><span class="kind" style="background:${color}">${escHtml(c.kind)}</span></div><p>${escHtml(c.description || '')}</p><ul>${files}</ul></div>`;
  }).join('');
  const flagHtml = flags.length ? `<div class="flags"><b>⚠ Flags</b><ul>${flags.map(f => `<li>${escHtml(f.replace(/\*\*/g, ''))}</li>`).join('')}</ul></div>` : '';
  const unmapped = res.unmapped.length ? `<div class="unmapped">Unmapped: ${res.unmapped.map(f => `<code>${escHtml(f)}</code>`).join(' ')}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(systemName(arch))} — architecture map</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#F7F7F5;color:#1F2433}header{padding:18px 26px;background:#1F2433;color:#FFF7EE;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}header h1{font-size:19px;margin:0}header p{margin:0;color:#C0BCBA;font-size:13px}main{display:flex;gap:18px;padding:18px 26px;align-items:flex-start;flex-wrap:wrap}#map{flex:2;min-width:460px;background:#fff;border:1px solid #DDD;border-radius:10px;padding:12px;overflow:auto}#side{flex:1;min-width:300px;display:flex;flex-direction:column;gap:12px}.card{background:#fff;border:1px solid #DDD;border-radius:10px;padding:13px 15px}.ch{display:flex;justify-content:space-between;gap:10px}.kind{color:#fff;font-size:12px;padding:2px 10px;border-radius:10px;height:fit-content}.card p{color:#595959;font-size:13px;margin:6px 0}ul{margin:4px 0 0;padding-left:18px;font-size:13px}code{background:#F1F1EE;padding:1px 5px;border-radius:4px}.flags{background:#FDE8E4;border:1px solid #C2410C;border-radius:10px;padding:11px 15px;font-size:14px}.unmapped{background:#FFF4E0;border:1px solid #B45309;border-radius:10px;padding:11px 15px;font-size:13px}</style></head>
<body><header><h1>${escHtml(systemName(arch))} — architecture map</h1><p>${mode}</p></header>
<main><div id="map"><pre class="mermaid">\n${mermaid(arch, touched)}\n</pre></div><div id="side">${flagHtml}${cards}${unmapped}</div></main>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: 'neutral', flowchart: { useMaxWidth: true } });</script>
</body></html>`;
}

module.exports = {
  findModelPath, loadArch, renderHtml, systemName, lanesOf, laneTitles, globToRe, mapFiles,
  changedFiles, collectFlags, mermaid, renderText, renderMd, renderFullMd, KIND_STYLE
};
