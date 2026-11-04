'use strict';
// archwhere rail: pure categorisation logic for mission control. No network, no fs.

const { mapFiles } = require('./where');

/** "git@github.com:o/r.git" | "https://github.com/o/r.git" -> { owner, repo } */
function parseRepo(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!m) throw new Error('cannot parse GitHub remote: ' + url);
  return { owner: m[1], repo: m[2] };
}

/** "[voice] fix: …" -> "voice" (or null) */
function componentFromTitle(title) {
  const m = String(title || '').match(/^\[([a-z0-9-]+)\]/);
  return m ? m[1] : null;
}

const threadLabel = id => `component:${id}`;
const componentFromLabel = name => {
  const m = String(name || '').match(/^component:([a-z0-9-]+)$/);
  return m ? m[1] : null;
};

/** check-runs list -> 'success' | 'failure' | 'pending' | 'none' */
function checksConclusion(checkRuns) {
  const runs = checkRuns || [];
  if (!runs.length) return 'none';
  if (runs.some(r => r.status !== 'completed')) return 'pending';
  if (runs.some(r => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion))) return 'failure';
  return 'success';
}

/** Which components a PR touches: mapped files first, then the title prefix. */
function prComponents(arch, pr) {
  const fromFiles = pr.files && pr.files.length
    ? [...mapFiles(arch, pr.files).byComponent.keys()] : [];
  if (fromFiles.length) return fromFiles;
  const t = componentFromTitle(pr.title);
  return t && arch.components[t] ? [t] : [];
}

function hasLabel(item, ...names) {
  const have = (item.labels || []).map(l => (typeof l === 'string' ? l : l.name));
  return names.some(n => have.includes(n));
}

/**
 * Build the attention rail. Items appear once, by priority:
 * security > blocked > attention > mergeable. Flags carry the rest.
 */
function buildRail(arch, { prs = [], issues = [] } = {}) {
  const rail = { security: [], blocked: [], attention: [], mergeable: [] };

  for (const is of issues) {
    const components = (is.labels || [])
      .map(l => componentFromLabel(typeof l === 'string' ? l : l.name))
      .filter(c => c && arch.components[c]);
    const item = {
      kind: 'issue', number: is.number, title: is.title, components,
      comments: is.comments || 0, url: is.html_url || ''
    };
    if (hasLabel(is, 'security')) rail.security.push(item);
    else if (hasLabel(is, 'blocked', 'needs-owner')) rail.blocked.push(item);
  }

  for (const pr of prs) {
    const components = prComponents(arch, pr);
    const checks = checksConclusion(pr.checkRuns);
    const touchesSecurity = components.some(c => arch.components[c] && arch.components[c].kind === 'security');
    const ownerReview = hasLabel(pr, 'owner-review', 'security');
    const conflicted = pr.mergeable === false || pr.mergeable_state === 'dirty';
    const item = {
      kind: 'pr', number: pr.number, title: pr.title, components,
      comments: (pr.comments || 0) + (pr.review_comments || 0), url: pr.html_url || '',
      checks, draft: !!pr.draft, conflicted,
      flags: [
        ...(ownerReview ? ['owner-review'] : []),
        ...(touchesSecurity ? ['touches security component'] : []),
        ...(conflicted ? ['merge conflict'] : [])
      ]
    };
    if (ownerReview || touchesSecurity) rail.security.push(item);
    else if (hasLabel(pr, 'blocked', 'needs-owner')) rail.blocked.push(item);
    else if (checks === 'success' && !item.draft && !conflicted) rail.mergeable.push(item);
    else rail.attention.push(item);
  }
  return rail;
}

/** Per-component rollup for map badges: open threads, PRs, worst alert. */
function componentBadges(arch, { prs = [], issues = [] } = {}, rail) {
  const out = {};
  const ensure = id => (out[id] = out[id] || { threads: 0, prs: [], alert: null });
  for (const is of issues) {
    for (const l of is.labels || []) {
      const c = componentFromLabel(typeof l === 'string' ? l : l.name);
      if (c && arch.components[c]) ensure(c).threads += 1;
    }
  }
  for (const pr of prs) for (const c of prComponents(arch, pr)) ensure(c).prs.push(pr.number);
  const mark = (items, level) => {
    for (const it of items) for (const c of it.components) {
      const b = ensure(c);
      if (!b.alert || level === 'security') b.alert = level;
    }
  };
  if (rail) { mark(rail.blocked, 'blocked'); mark(rail.security, 'security'); }
  return out;
}

/** BYOA: which mention summons the configured coding agent. '' disables auto-summon. */
function resolveAgentMention(env, fileCfg) {
  if (env && env.AGENT_MENTION !== undefined) return String(env.AGENT_MENTION);
  if (fileCfg && fileCfg.agentMention !== undefined) return String(fileCfg.agentMention);
  return '@claude';
}

const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `body` mention `mention` as a whole handle? ("@kiro" matches "hi @Kiro," but not "@kirotron"). */
function hasMention(body, mention) {
  if (!mention) return false;
  return new RegExp('(^|[^\\w@/.-])' + escRe(mention) + '(?![\\w-])', 'i').test(String(body || ''));
}

/** "Claude=@claude,Kiro=@kiro" -> [{name:'Claude',mention:'@claude'},{name:'Kiro',mention:'@kiro'}]. A bare "@kiro" names itself "kiro". */
function parseAgentMentions(str) {
  const out = [];
  for (const part of String(str || '').split(',')) {
    const t = part.trim(); if (!t) continue;
    const eq = t.indexOf('=');
    let name = eq === -1 ? '' : t.slice(0, eq).trim();
    let mention = (eq === -1 ? t : t.slice(eq + 1)).trim();
    if (!mention) continue;
    if (!mention.startsWith('@')) mention = '@' + mention;
    if (!name) name = mention.slice(1);
    out.push({ name, mention });
  }
  return dedupeAgents(out);
}

function dedupeAgents(list) {
  const seen = new Set();
  return list.filter(a => {
    const k = a.mention.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

const defaultName = m => (m.toLowerCase() === '@claude' ? 'Claude' : m.replace(/^@/, ''));

/**
 * Which agents the board can summon, first = default.
 * env AGENT_MENTIONS > env AGENT_MENTION > config `agents` > config `agentMention` > [Claude].
 * An empty single mention ('') disables summoning: [].
 */
function resolveAgents(env, fileCfg) {
  env = env || {}; fileCfg = fileCfg || {};
  if (env.AGENT_MENTIONS !== undefined && String(env.AGENT_MENTIONS).trim()) return parseAgentMentions(env.AGENT_MENTIONS);
  if (env.AGENT_MENTION === undefined && Array.isArray(fileCfg.agents)) {
    return dedupeAgents(fileCfg.agents
      .map(a => (typeof a === 'string' ? parseAgentMentions(a)[0] : a))
      .filter(a => a && a.mention)
      .map(a => {
        const mention = a.mention.startsWith('@') ? a.mention : '@' + a.mention;
        return { name: a.name || defaultName(mention), mention };
      }));
  }
  const single = resolveAgentMention(env, fileCfg);
  return single ? [{ name: defaultName(single), mention: single }] : [];
}

/** The mentions to summon for a choice: an agent name or mention, 'all'/'both', or a list. Unknown -> the default agent. */
function selectMentions(agents, choice) {
  agents = agents || [];
  if (!agents.length) return [];
  const pick = c => {
    const k = String(c || '').trim().toLowerCase();
    if (k === 'all' || k === 'both') return agents.map(a => a.mention);
    const a = agents.find(x => x.name.toLowerCase() === k || x.mention.toLowerCase() === k || x.mention.toLowerCase() === '@' + k);
    return a ? [a.mention] : [];
  };
  const got = [...new Set((Array.isArray(choice) ? choice : [choice]).flatMap(pick))];
  return got.length ? got : [agents[0].mention];
}

/**
 * Append the summon when configured and not already present.
 * `mentions` is one mention or a list; `known` (default: `mentions`) is every agent mention the board
 * knows. If the text already names any known agent, nothing is appended: a hand-typed "@kiro" wins.
 */
function withSummon(body, mentions, suffix, known) {
  const want = (Array.isArray(mentions) ? mentions : [mentions]).filter(Boolean);
  if (!want.length) return body;
  const all = [...new Set([...(known || []), ...want])];
  if (all.some(m => hasMention(body, m))) return body;
  return body + '\n\n' + want.join(' ') + (suffix || '');
}

/**
 * Which agent wrote a comment, for the UI: a bridge reply ("🤖 **Kiro** (via archwhere bridge)") or a
 * bot login that matches an agent ("claude[bot]" -> Claude). null when it looks human.
 */
function replyAgent(c, agents) {
  const body = String((c && c.body) || '');
  const m = body.match(/^\s*🤖\s*\*\*([^*\n]{1,40})\*\*\s*\(via archwhere bridge\)/);
  if (m) return m[1].trim();
  const login = String((c && c.user) || '').toLowerCase();
  const bot = (c && c.userType === 'Bot') || login.endsWith('[bot]');
  if (!bot) return null;
  const bare = login.replace(/\[bot\]$/, '');
  const a = (agents || []).find(x => bare === x.mention.slice(1).toLowerCase() || bare.startsWith(x.mention.slice(1).toLowerCase()));
  return a ? a.name : null;
}

/** Components of the map that an open PR touches, once each; anything not on the map is left out. */
function touchedComponents(arch, prs = []) {
  return [...new Set(prs.flatMap(p => p.components || []))].filter(id => arch.components[id]);
}

module.exports = {
  touchedComponents, parseRepo, componentFromTitle, threadLabel, componentFromLabel,
  checksConclusion, prComponents, buildRail, componentBadges,
  resolveAgentMention, withSummon, hasMention, parseAgentMentions, resolveAgents,
  selectMentions, replyAgent
};
