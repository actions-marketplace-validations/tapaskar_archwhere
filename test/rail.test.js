'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const W = require('../lib/where');
const L = require('../lib/rail');

const arch = W.loadArch(path.join(__dirname, '..', 'examples', 'meridian'));

test('parseRepo handles ssh and https', () => {
  assert.deepStrictEqual(L.parseRepo('git@github.com:acme/meridian.git'), { owner: 'acme', repo: 'meridian' });
  assert.deepStrictEqual(L.parseRepo('https://github.com/acme/meridian'), { owner: 'acme', repo: 'meridian' });
  assert.throws(() => L.parseRepo('https://gitlab.com/a/b'));
});

test('checksConclusion aggregates', () => {
  assert.strictEqual(L.checksConclusion([]), 'none');
  assert.strictEqual(L.checksConclusion([{ status: 'in_progress' }]), 'pending');
  assert.strictEqual(L.checksConclusion([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]), 'failure');
});

const fx = {
  prs: [
    { number: 1, title: '[search] feature: typo fix', files: ['features/search/q.js'], labels: [],
      checkRuns: [{ status: 'completed', conclusion: 'success' }], mergeable: true },
    { number: 2, title: 'tighten sessions', files: ['core/auth/session.js'], labels: [],
      checkRuns: [{ status: 'completed', conclusion: 'success' }], mergeable: true },
    { number: 3, title: '[billing] feature: proration', files: ['features/billing/p.js'], labels: [],
      checkRuns: [{ status: 'completed', conclusion: 'failure' }], mergeable: true },
    { number: 4, title: '[docs] docs: readme', files: ['README.md'], labels: [],
      checkRuns: [{ status: 'completed', conclusion: 'success' }], mergeable: false, mergeable_state: 'dirty' }
  ],
  issues: [
    { number: 10, title: 'token leak', labels: [{ name: 'security' }, { name: 'component:auth' }], comments: 2 },
    { number: 11, title: 'pick a search vendor', labels: [{ name: 'blocked' }, { name: 'component:search' }], comments: 4 },
    { number: 12, title: 'search thread', labels: [{ name: 'component:search' }], comments: 3 }
  ]
};

test('rail priority: security > blocked > attention > mergeable, no duplicates', () => {
  const rail = L.buildRail(arch, fx);
  const n = s => rail[s].map(i => `${i.kind}#${i.number}`).sort();
  assert.deepStrictEqual(n('security'), ['issue#10', 'pr#2']);        // pr#2 via auth (kind security)
  assert.deepStrictEqual(n('blocked'), ['issue#11']);
  assert.deepStrictEqual(n('mergeable'), ['pr#1']);
  assert.deepStrictEqual(n('attention'), ['pr#3', 'pr#4']);
  const all = Object.values(rail).flat().map(i => `${i.kind}#${i.number}`);
  assert.strictEqual(new Set(all).size, all.length);
});

test('badges roll up threads, PRs, worst alert', () => {
  const rail = L.buildRail(arch, fx);
  const b = L.componentBadges(arch, fx, rail);
  assert.strictEqual(b.search.threads, 2);
  assert.strictEqual(b.search.alert, 'blocked');
  assert.strictEqual(b.auth.alert, 'security');
  assert.ok(b.search.prs.includes(1));
});

test('BYOA: resolveAgentMention and withSummon', () => {
  assert.strictEqual(L.resolveAgentMention({}, {}), '@claude');
  assert.strictEqual(L.resolveAgentMention({ AGENT_MENTION: '@mybot' }, { agentMention: '@x' }), '@mybot');
  assert.strictEqual(L.resolveAgentMention({}, { agentMention: '' }), '');
  assert.strictEqual(L.withSummon('hello', ''), 'hello');
  assert.ok(L.withSummon('hello', '@mybot').endsWith('@mybot'));
  assert.strictEqual(L.withSummon('hey @MyBot look', '@mybot'), 'hey @MyBot look');
});
