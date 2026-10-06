// Matches rota names ("Pao Go-Aco") to Jira users returned by a user search.

export function nameKey(name = '') {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(name) {
  return new Set(nameKey(name).split(' ').filter(Boolean));
}

// 1 = same name; otherwise the share of the rota name's words found in the Jira name.
export function nameScore(rotaName, jiraName) {
  if (nameKey(rotaName) === nameKey(jiraName)) return 1;
  const wanted = tokens(rotaName);
  const have = tokens(jiraName);
  if (!wanted.size) return 0;
  const hits = [...wanted].filter(t => have.has(t)).length;
  return Math.round((hits / wanted.size) * 0.9 * 100) / 100;
}

// Only an exact name match (or a single strong candidate) is auto-selected; anything else is left for
// the admin to pick in the preview.
export function matchUser(rotaName, users = []) {
  const candidates = users
    .filter(u => u?.accountId && u.accountType !== 'app' && u.accountType !== 'customer' && u.active !== false)
    .map(u => ({ accountId: u.accountId, displayName: u.displayName || u.accountId, score: nameScore(rotaName, u.displayName) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
    .slice(0, 5);
  const exact = candidates.filter(c => c.score === 1);
  const strong = candidates.filter(c => c.score >= 0.85);
  const match = exact.length === 1 ? exact[0] : (!exact.length && strong.length === 1 ? strong[0] : null);
  return { match, candidates };
}
