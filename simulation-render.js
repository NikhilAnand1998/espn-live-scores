(() => {
  'use strict';
  const data = window.simulatedDrafts;
  const meta = document.querySelector('#simulation-meta');
  const strategies = document.querySelector('#simulation-strategy-grid');
  const filters = document.querySelector('#simulation-filters');
  const drafts = document.querySelector('#simulation-draft-list');
  const method = document.querySelector('#simulation-method');
  const badge = document.querySelector('#simulation-count-badge');
  let active = 'overall';

  const esc = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const num = (value, digits = 0) => Number.isFinite(Number(value))
    ? Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';
  const realism = value => value === 'Conservative'
    ? 'realistic'
    : value === 'Value-dependent'
      ? 'aggressive'
      : 'dream';

  function pickRow(pick) {
    const probability = Number(pick.availability);
    const probabilityClass = probability < 10 ? 'longshot' : probability < 30 ? 'faller' : '';
    const lineupClass = String(pick.role).startsWith('BN') ? 'bench' : 'starter';
    const specialist = pick.pos === 'DEF' || pick.pos === 'K';
    const market = specialist
      ? '<b>Final-round slot</b><small>Reserved by roster rule</small>'
      : `<b>ADP ${pick.adp === null ? '—' : num(pick.adp, 1)}</b><small class="${probabilityClass}">${num(probability, 1)}% available</small>`;
    return `<li class="simulation-pick ${lineupClass}">
      <span class="simulation-pick-round">R${pick.round}<small>#${pick.overall}</small></span>
      <span class="simulation-pick-player"><b>${esc(pick.name)}</b><small>${esc(pick.pos)} · ${esc(pick.team || 'FA')} · ${esc(pick.role)}</small></span>
      <span class="simulation-pick-market">${market}</span>
    </li>`;
  }

  function displayedRank(draft, index) {
    if (active === 'overall') return draft.overallRank || index + 1;
    if (active === 'ceiling') return draft.ceilingRank || index + 1;
    return draft.strategyRank || index + 1;
  }

  function draftCard(draft, index) {
    const rank = displayedRank(draft, index);
    const firstSix = draft.picks.slice(0, 6)
      .map(pick => `<span>${esc(pick.name)} <small>${esc(pick.pos)}</small></span>`).join('');
    return `<article class="simulation-draft-card" data-simulation-draft="${esc(draft.id)}">
      <header class="simulation-draft-header">
        <span class="simulation-draft-rank">#${rank}</span>
        <span class="simulation-draft-title"><small>${esc(draft.strategyLabel)} · ${esc(draft.scenarioLabel)}</small><b>${esc(draft.opening)}</b></span>
        <span class="simulation-realism ${realism(draft.realism)}">${esc(draft.realism)}</span>
      </header>
      <div class="simulation-score-grid">
        <span><b>${num(draft.modelScore, 1)}</b><small>Practical score</small></span>
        <span><b>${num(draft.percentile, 1)}%</b><small>Conservative percentile</small></span>
        <span><b>${num(draft.weeklyExpected, 1)}</b><small>Expected pts/week</small></span>
        <span><b>${num(draft.weakestAvailability, 1)}%</b><small>Lowest skill-pick chance</small></span>
      </div>
      <div class="simulation-range" aria-label="Projected weekly starter range">
        <span><small>Floor</small><b>${num(draft.weeklyFloor, 1)}</b></span>
        <span class="expected"><small>Expected</small><b>${num(draft.weeklyExpected, 1)}</b></span>
        <span><small>Ceiling</small><b>${num(draft.weeklyCeiling, 1)}</b></span>
      </div>
      <div class="simulation-headline-picks" aria-label="First six selections">${firstSix}</div>
      <div class="simulation-draft-flags">
        <span>${draft.sub15Count} skill pick${draft.sub15Count === 1 ? '' : 's'} below 15%</span>
        <span>${draft.longShotCount} skill pick${draft.longShotCount === 1 ? '' : 's'} below 10%</span>
        <span>${draft.reachCount} material reach${draft.reachCount === 1 ? '' : 'es'}</span>
      </div>
      <details class="simulation-picks-details" ${index === 0 ? 'open' : ''}>
        <summary>View all 16 picks and lineup roles</summary>
        <ol class="simulation-pick-list">${draft.picks.map(pickRow).join('')}</ol>
      </details>
    </article>`;
  }

  function rowsForActiveFilter() {
    if (active === 'overall') return data.overall || [];
    if (active === 'ceiling') return data.ceiling || [];
    return data.byStrategy?.[active] || [];
  }

  function renderDrafts() {
    const rows = rowsForActiveFilter();
    drafts.innerHTML = rows.length
      ? rows.map(draftCard).join('')
      : '<div class="simulation-empty"><b>No ranked drafts are available.</b><span>The next data refresh will rebuild this tab.</span></div>';
  }

  function renderFilters() {
    const summaryById = new Map(data.strategySummary.map(row => [row.id, row]));
    const button = (id, label, count) => `<button class="simulation-filter ${active === id ? 'active' : ''}" type="button" data-simulation-filter="${esc(id)}" aria-pressed="${active === id}">${esc(label)}<span>${num(count)}</span></button>`;
    filters.innerHTML = button('overall', 'Best practical', data.overall.length)
      + Object.keys(data.byStrategy).map(id => button(id, summaryById.get(id)?.shortLabel || id, data.byStrategy[id].length)).join('')
      + button('ceiling', 'Ceiling outcomes', data.ceiling?.length || 0);
  }

  function choose(id) {
    active = id;
    renderFilters();
    renderDrafts();
    document.querySelector('#ranked-drafts-heading')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  if (!data) {
    document.querySelector('[data-app-panel="simulations"]').innerHTML = '<div class="simulation-empty"><b>Simulation results did not load.</b><span>Refresh after deployment completes.</span></div>';
    return;
  }

  const m = data.meta;
  badge.textContent = num(m.totalCompletedDrafts);
  meta.innerHTML = `<span><b>${num(m.totalCompletedDrafts)}</b><small>complete drafts</small></span>
    <span><b>${num(m.rooms)}</b><small>independent rooms</small></span>
    <span><b>${num(m.strategies)}</b><small>strategies per room</small></span>
    <span><b>Pick ${num(m.slot)}</b><small>${esc(m.teams)}-team ${esc(m.scoring)}</small></span>`;
  strategies.innerHTML = data.strategySummary.map((row, index) => {
    const opening = row.commonOpenings?.[0];
    return `<button class="simulation-strategy-card" type="button" data-strategy-jump="${esc(row.id)}">
      <span class="simulation-strategy-rank">#${index + 1}</span>
      <span class="simulation-strategy-copy"><b>${esc(row.label)}</b><small>${esc(row.description)}</small></span>
      <span class="simulation-strategy-metrics">
        <span><b>${num(row.averageRank, 2)}</b><small>Avg rank</small></span>
        <span><b>${num(row.bestInRoomRate, 1)}%</b><small>Best in room</small></span>
        <span><b>${num(row.averageWeeklyStarter, 1)}</b><small>Pts/week</small></span>
      </span>
      ${opening ? `<span class="simulation-opening">Common start · ${esc(opening.opening)} (${num(opening.rate, 1)}%)</span>` : ''}
    </button>`;
  }).join('');

  const props = Number(m.marketPropPlayers || 0) > 0
    ? `${num(m.marketPropPlayers)} players had market-prop inputs in this run.`
    : 'No player-prop market feed was available in this run, so rankings use the current projection ensemble, floors, ceilings, consensus ranks, and exact-format ADP.';
  method.innerHTML = `<h2>How these drafts are ranked</h2><p>${esc(m.simulationMethod)}</p><p>${esc(m.rankingMethod)}</p><p>${esc(m.displayPolicy || '')}</p><p>${esc(props)}</p><small>Each percentage is that skill player’s estimated availability at one specific pick. It is not a literal joint probability for the entire roster. The default list prevents several low-probability falls from being stacked into the same recommended team; extreme rooms are shown separately under Ceiling outcomes. DEF and K percentages are omitted because those positions are deliberately reserved for the final two rounds.</small>`;

  filters.addEventListener('click', event => {
    const target = event.target.closest('[data-simulation-filter]');
    if (target) choose(target.dataset.simulationFilter);
  });
  strategies.addEventListener('click', event => {
    const target = event.target.closest('[data-strategy-jump]');
    if (target) choose(target.dataset.strategyJump);
  });

  renderFilters();
  renderDrafts();
})();
