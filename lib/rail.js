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

/** Append the summon when configured and not already present. */
function withSummon(body, mention, suffix) {
  if (!mention) return body;
  const re = new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return re.test(body) ? body : body + '\n\n' + mention + (suffix || '');
}

module.exports = {
  parseRepo, componentFromTitle, threadLabel, componentFromLabel,
  checksConclusion, prComponents, buildRail, componentBadges,
  resolveAgentMention, withSummon
};
