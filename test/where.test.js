'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const W = require('../lib/where');

const EX = path.join(__dirname, '..', 'examples', 'meridian');
const arch = W.loadArch(EX);

test('example model loads and is well-formed', () => {
  assert.strictEqual(W.systemName(arch), 'Meridian');
  for (const [id, c] of Object.entries(arch.components)) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(c.name && c.kind && Array.isArray(c.paths) && c.paths.length, id);
    for (const d of c.deps || []) assert.ok(arch.components[d], `${id} dep ${d}`);
  }
});

test('glob semantics: * stays within a segment, ** crosses', () => {
  assert.ok(W.globToRe('web/*.js').test('web/a.js'));
  assert.ok(!W.globToRe('web/*.js').test('web/a/b.js'));
  assert.ok(W.globToRe('web/**').test('web/a/b.js'));
  assert.ok(W.globToRe('*.md').test('README.md'));
  assert.ok(!W.globToRe('*.md').test('docs/x.md'));
});

test('most specific glob wins; unmapped reported', () => {
  const { byComponent, unmapped } = W.mapFiles(arch, [
    'core/auth/session.js', 'core/tickets/sla.js', 'web/app.js', 'README.md', 'mystery/file.x'
  ]);
  const get = f => { for (const [id, fs] of byComponent) if (fs.includes(f)) return id; };
  assert.strictEqual(get('core/auth/session.js'), 'auth');
  assert.strictEqual(get('core/tickets/sla.js'), 'ticket-engine');
  assert.strictEqual(get('web/app.js'), 'web-app');
  assert.strictEqual(get('README.md'), 'docs');
  assert.deepStrictEqual(unmapped, ['mystery/file.x']);
});

test('lanes: declared wins; fallback groups by kind', () => {
  assert.deepStrictEqual(W.lanesOf(arch)[0], ['web-app', 'mobile-api', 'admin-console']);
  const noLanes = { ...arch, lanes: undefined };
  const lanes = W.lanesOf(noLanes);
  assert.ok(lanes.flat().length === Object.keys(arch.components).length);
  assert.deepStrictEqual(W.laneTitles(arch)[1], 'CORE · SECURITY');
});

test('doc and mermaid render with flows and styles', () => {
  const doc = W.renderFullMd(arch);
  assert.ok(doc.includes('Meridian — architecture map'));
  assert.ok(doc.includes('Customer reply to resolved ticket'));
  assert.ok(doc.includes('Web app → Ticket engine'));
  const mm = W.mermaid(arch, ['auth']);
  assert.ok(mm.includes('classDef security'));
  assert.ok(mm.includes('class auth touched'));
});
