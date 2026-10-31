'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { inferModel } = require('../lib/infer');
const W = require('../lib/where');

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archwhere-'));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  g(root, 'init', '-q');
  g(root, 'add', '-A');
  g(root, 'commit', '-qm', 'init');
  return root;
}

test('inferModel drafts components with sane kinds and a passing check', () => {
  const root = makeRepo({
    'package.json': '{"name":"demo"}\n',
    'README.md': '# demo\n',
    'lib/core.js': "const u = require('../ui/app');\nmodule.exports = {};\n",
    'lib/db.js': 'module.exports = 1;\n',
    'ui/app.js': 'module.exports = 2;\n',
    'auth/login.js': 'module.exports = 3;\n',
    'docs/guide.md': 'hi\n'
  });
  const { model, stats } = inferModel(root);
  assert.equal(model.system, 'demo');
  assert.ok(stats.components >= 4);
  assert.equal(model.components.lib.kind, 'core');
  assert.equal(model.components.ui.kind, 'product');
  assert.equal(model.components.auth.kind, 'security');
  assert.equal(model.components.docs.kind, 'docs');
  // import edge lib -> ui found
  assert.ok(model.components.lib.deps.includes('ui'));
  // every tracked file maps: the model passes check by construction
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const { unmapped } = W.mapFiles(model, tracked);
  assert.deepEqual(unmapped, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('inferModel splits workspaces into components', () => {
  const root = makeRepo({
    'package.json': '{"name":"mono","workspaces":["packages/*"]}\n',
    'packages/api/package.json': '{"name":"@mono/api"}\n',
    'packages/api/index.js': 'x\n',
    'packages/site/package.json': '{"name":"@mono/site"}\n',
    'packages/site/index.js': 'x\n'
  });
  const { model } = inferModel(root);
  assert.ok(model.components.api, 'workspace api becomes a component');
  assert.ok(model.components.site, 'workspace site becomes a component');
  fs.rmSync(root, { recursive: true, force: true });
});

test('suggestPatch adopts near files and proposes new components for far ones', () => {
  const arch = { components: {
    core: { name: 'Core', kind: 'core', paths: ['lib/sub/**'] },
    docs: { name: 'Docs', kind: 'docs', paths: ['docs/**'] }
  } };
  const patch = W.suggestPatch(arch, ['lib/other/y.js', 'brandnew/a.js', 'brandnew/b.js']);
  assert.deepEqual(patch.additions.core, ['lib/other/y.js']);
  assert.equal(patch.fresh.length, 1);
  assert.equal(patch.fresh[0].id, 'brandnew');
  assert.equal(patch.fresh[0].glob, 'brandnew/**');
  const lines = W.patchLines(arch, patch);
  assert.ok(lines.some(l => l.includes('components.core.paths')));
});

test('applyPatch writes adopted globs and new components into the model file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archwhere-'));
  fs.mkdirSync(path.join(root, 'arch'));
  fs.writeFileSync(path.join(root, 'arch', 'architecture.json'), JSON.stringify({
    system: 'demo', components: { core: { name: 'Core', kind: 'core', paths: ['lib/**'] } }
  }));
  const arch = W.loadArch(root);
  W.applyPatch(arch, { additions: { core: ['lib2/x.js'] }, fresh: [{ id: 'web', glob: 'web/**', files: ['web/a.js'] }] });
  const after = JSON.parse(fs.readFileSync(path.join(root, 'arch', 'architecture.json'), 'utf8'));
  assert.ok(after.components.core.paths.includes('lib2/x.js'));
  assert.equal(after.components.web.kind, 'feature');
  assert.deepEqual(after.components.web.paths, ['web/**']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('changeHeat counts recent changes per component', () => {
  const root = makeRepo({ 'lib/a.js': '1\n', 'docs/d.md': 'x\n' });
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), '2\n');
  g(root, 'commit', '-aqm', 'touch lib');
  const arch = { components: {
    core: { name: 'Core', kind: 'core', paths: ['lib/**'] },
    docs: { name: 'Docs', kind: 'docs', paths: ['docs/**', '*'] }
  } };
  const heat = W.changeHeat(root, arch, 30);
  assert.ok(heat.components.core.changes >= 2, 'lib/a.js changed in two commits');
  assert.equal(heat.components.core.files, 1);
  assert.ok(heat.max >= heat.components.core.changes);
  fs.rmSync(root, { recursive: true, force: true });
});
