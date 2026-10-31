'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const W = require('../lib/where');
const { systemIR, flowIR } = require('../lib/archify');

const arch = W.loadArch(path.join(__dirname, '..', 'examples', 'meridian'));

test('archify IR: required fields, valid endpoints, ≤5 views', () => {
  const docs = [systemIR(arch)];
  for (const [fid, f] of Object.entries(arch.flows || {})) docs.push(flowIR(arch, fid, f));
  for (const d of docs) {
    for (const k of ['schema_version', 'diagram_type', 'meta', 'components']) assert.ok(k in d, 'missing ' + k);
    assert.ok(d.meta.output, 'meta.output is required by the archify schema');
    const ids = new Set(d.components.map(c => c.id));
    for (const c of d.connections || []) assert.ok(ids.has(c.from) && ids.has(c.to), `${c.from}->${c.to}`);
    for (const v of (d.meta.views || [])) for (const id of v.focus) assert.ok(ids.has(id));
    assert.ok((d.meta.views || []).length <= 5);
    for (const b of d.boundaries || []) for (const id of b.wraps) assert.ok(ids.has(id), 'boundary wraps unknown ' + id);
  }
});

test('security lane becomes a security-group boundary; views include flows', () => {
  const sys = systemIR(arch);
  assert.ok(sys.boundaries.some(b => b.kind === 'security-group'));
  assert.ok(sys.meta.views.some(v => v.id === 'flow-ticket-reply'));
  assert.ok(sys.meta.views.some(v => v.id === 'security-zones'));
});
