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

test('multi-agent: parseAgentMentions and resolveAgents', () => {
  assert.deepStrictEqual(L.parseAgentMentions('Claude=@claude, Kiro=@kiro'),
    [{ name: 'Claude', mention: '@claude' }, { name: 'Kiro', mention: '@kiro' }]);
  assert.deepStrictEqual(L.parseAgentMentions('@kiro,Bot=mybot,,Dup=@KIRO'),
    [{ name: 'kiro', mention: '@kiro' }, { name: 'Bot', mention: '@mybot' }]);
  // default, single env, single config, agents config, env list wins
  assert.deepStrictEqual(L.resolveAgents({}, {}), [{ name: 'Claude', mention: '@claude' }]);
  assert.deepStrictEqual(L.resolveAgents({ AGENT_MENTION: '@mybot' }, { agents: [{ name: 'X', mention: '@x' }] }), [{ name: 'mybot', mention: '@mybot' }]);
  assert.deepStrictEqual(L.resolveAgents({}, { agentMention: '@bot' }), [{ name: 'bot', mention: '@bot' }]);
  assert.deepStrictEqual(L.resolveAgents({}, { agentMention: '' }), []);
  assert.deepStrictEqual(L.resolveAgents({ AGENT_MENTION: '' }, {}), []);
  assert.deepStrictEqual(L.resolveAgents({}, { agents: [{ name: 'Claude', mention: '@claude' }, { mention: 'kiro' }] }),
    [{ name: 'Claude', mention: '@claude' }, { name: 'kiro', mention: '@kiro' }]);
  assert.deepStrictEqual(L.resolveAgents({ AGENT_MENTIONS: 'Claude=@claude,Kiro=@kiro', AGENT_MENTION: '@x' }, { agents: [] }).map(a => a.name), ['Claude', 'Kiro']);
});

test('multi-agent: hasMention is a whole-handle match', () => {
  assert.ok(L.hasMention('hi @Kiro, why?', '@kiro'));
  assert.ok(L.hasMention('@kiro', '@kiro'));
  assert.ok(!L.hasMention('hi @kirotron', '@kiro'));
  assert.ok(!L.hasMention('mail me@kiro.dev', '@kiro'));
  assert.ok(!L.hasMention('anything', ''));
});

test('multi-agent: selectMentions and multi-mention summon', () => {
  const agents = L.resolveAgents({ AGENT_MENTIONS: 'Claude=@claude,Kiro=@kiro' });
  const known = agents.map(a => a.mention);
  assert.deepStrictEqual(L.selectMentions(agents, 'Kiro'), ['@kiro']);
  assert.deepStrictEqual(L.selectMentions(agents, 'both'), ['@claude', '@kiro']);
  assert.deepStrictEqual(L.selectMentions(agents, 'all'), ['@claude', '@kiro']);
  assert.deepStrictEqual(L.selectMentions(agents, undefined), ['@claude']);
  assert.deepStrictEqual(L.selectMentions(agents, 'nobody'), ['@claude']);
  assert.deepStrictEqual(L.selectMentions([], 'all'), []);
  assert.strictEqual(L.withSummon('why?', ['@claude', '@kiro'], '', known), 'why?\n\n@claude @kiro');
  assert.strictEqual(L.withSummon('why?', ['@kiro'], ' please look', known), 'why?\n\n@kiro please look');
  // back-compat: a single string mention still works
  assert.strictEqual(L.withSummon('why?', '@claude'), 'why?\n\n@claude');
});

test('multi-agent: a typed mention wins (never also summons the selected agent)', () => {
  const known = ['@claude', '@kiro'];
  assert.strictEqual(L.withSummon('@kiro what does rail.js do?', ['@claude'], ' suffix', known), '@kiro what does rail.js do?');
  assert.strictEqual(L.withSummon('ask @Claude here', ['@kiro'], '', known), 'ask @Claude here');
  assert.strictEqual(L.withSummon('ask @kirotron', ['@kiro'], '', known), 'ask @kirotron\n\n@kiro');
});

test('multi-agent: replyAgent labels who answered', () => {
  const agents = [{ name: 'Claude', mention: '@claude' }, { name: 'Kiro', mention: '@kiro' }];
  assert.strictEqual(L.replyAgent({ user: 'claude[bot]', body: 'done' }, agents), 'Claude');
  assert.strictEqual(L.replyAgent({ user: 'tapaskar', body: '🤖 **Kiro** (via archwhere bridge)\n\nhi' }, agents), 'Kiro');
  assert.strictEqual(L.replyAgent({ user: 'tapaskar', body: 'just me' }, agents), null);
  assert.strictEqual(L.replyAgent({ user: 'dependabot[bot]', body: 'bump' }, agents), null);
});

test('touchedComponents: each component once, and only ones on the map', () => {
  const a = { components: { x: {}, y: {} } };
  assert.deepStrictEqual(L.touchedComponents(a, [{ components: ['x', 'gone'] }, { components: ['x', 'y'] }, {}]), ['x', 'y']);
  assert.deepStrictEqual(L.touchedComponents(a), []);
});
