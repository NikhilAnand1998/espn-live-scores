(() => {
  'use strict';
  const data = window.simulatedDrafts;
  const meta = document.querySelector('#simulation-meta');
  const strategies = document.querySelector('#simulation-strategy-grid');
  const thresholds = document.querySelector('#simulation-thresholds');
  const thresholdSummary = document.querySelector('#simulation-threshold-summary');
  const thresholdPanel = document.querySelector('#simulation-threshold-panel');
  const filters = document.querySelector('#simulation-filters');
  const drafts = document.querySelector('#simulation-draft-list');
  const method = document.querySelector('#simulation-method');
  const badge = document.querySelector('#simulation-count-badge');
  let active = 'overall';
  let minimumAvailability = Number(data?.meta?.defaultAvailabilityThreshold ?? 35);
  const floorMaxRound = Number(data?.meta?.availabilityFloorMaxRound ?? 12);

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

  function thresholdBucket() {
    return data?.thresholds?.[String(minimumAvailability)] || {
      threshold: minimumAvailability,
      maxRound: floorMaxRound,
      eligibleDrafts: data?.overall?.length || 0,
      eligibleByStrategy: {},
      overall: data?.overall || [],
      byStrategy: data?.byStrategy || {}
    };
  }

  function corePicks(draft) {
    return (draft.picks || []).filter(pick =>
      pick.round <= floorMaxRound && !['DEF', 'K'].includes(pick.pos)
    );
  }

  function countCoreBelow(draft, threshold) {
    return corePicks(draft).filter(pick => Number(pick.availability) < threshold).length;
  }

  function pickRow(pick) {
    const probability = Number(pick.availability);
    const probabilityClass = probability < 10 ? 'longshot' : probability < 30 ? 'faller' : '';
    const lineupClass = String(pick.role).startsWith('BN') ? 'bench' : 'starter';
    const specialist = pick.pos === 'DEF' || pick.pos === 'K';
    const lateBenchException = !specialist && pick.round > floorMaxRound;
    let market;
    if (specialist) {
      market = '<b>Final-round slot</b><small>Reserved by roster rule</small>';
    } else if (lateBenchException) {
      market = `<b>ADP ${pick.adp === null ? '—' : num(pick.adp, 1)}</b><small class="${probabilityClass}">${num(probability, 1)}% · late-bench exception</small>`;
    } else {
      market = `<b>ADP ${pick.adp === null ? '—' : num(pick.adp, 1)}</b><small class="${probabilityClass}">${num(probability, 1)}% available</small>`;
    }
    return `<li class="simulation-pick ${lineupClass}">
      <span class="simulation-pick-round">R${pick.round}<small>#${pick.overall}</small></span>
      <span class="simulation-pick-player"><b>${esc(pick.name)}</b><small>${esc(pick.pos)} · ${esc(pick.team || 'FA')} · ${esc(pick.role)}</small></span>
      <span class="simulation-pick-market">${market}</span>
    </li>`;
  }

  function displayedRank(draft, index) {
    if (active === 'overall') return draft.thresholdRank || draft.overallRank || index + 1;
    if (active === 'ceiling') return draft.ceilingRank || index + 1;
    return draft.strategyThresholdRank || draft.strategyRank || index + 1;
  }

  function draftCard(draft, index) {
    const rank = displayedRank(draft, index);
    const firstSix = draft.picks.slice(0, 6)
      .map(pick => `<span>${esc(pick.name)} <small>${esc(pick.pos)}</small></span>`).join('');
    const coreMinimum = Number(draft.thresholdMinimumAvailability ?? draft.weakestAvailability);
    const coreBelow15 = countCoreBelow(draft, 15);
    const coreBelow10 = countCoreBelow(draft, 10);
    return `<article class="simulation-draft-card" data-simulation-draft="${esc(draft.id)}">
      <header class="simulation-draft-header">
        <span class="simulation-draft-rank">#${rank}</span>
        <span class="simulation-draft-title"><small>${esc(draft.strategyLabel)} · ${esc(draft.scenarioLabel)}</small><b>${esc(draft.opening)}</b></span>
        <span class="simulation-realism ${realism(draft.realism)}">${esc(draft.realism)}</span>
      </header>
      <div class="simulation-score-grid">
        <span><b>${num(draft.modelScore, 1)}</b><small>Practical score</small></span>
        <span><b>${num(draft.percentile, 1)}%</b><small>All-simulation percentile</small></span>
        <span><b>${num(draft.weeklyExpected, 1)}</b><small>Expected pts/week</small></span>
        <span><b>${num(coreMinimum, 1)}%</b><small>Lowest R1–${floorMaxRound} pick chance</small></span>
      </div>
      <div class="simulation-range" aria-label="Projected weekly starter range">
        <span><small>Floor</small><b>${num(draft.weeklyFloor, 1)}</b></span>
        <span class="expected"><small>Expected</small><b>${num(draft.weeklyExpected, 1)}</b></span>
        <span><small>Ceiling</small><b>${num(draft.weeklyCeiling, 1)}</b></span>
      </div>
      <div class="simulation-headline-picks" aria-label="First six selections">${firstSix}</div>
      <div class="simulation-draft-flags">
        <span>${coreBelow15} core pick${coreBelow15 === 1 ? '' : 's'} below 15%</span>
        <span>${coreBelow10} core pick${coreBelow10 === 1 ? '' : 's'} below 10%</span>
        <span>${draft.reachCount} material reach${draft.reachCount === 1 ? '' : 'es'}</span>
      </div>
      <details class="simulation-picks-details" ${index === 0 ? 'open' : ''}>
        <summary>View all 16 picks and lineup roles</summary>
        <ol class="simulation-pick-list">${draft.picks.map(pickRow).join('')}</ol>
      </details>
    </article>`;
  }

  function rowsForActiveFilter() {
    if (active === 'ceiling') return data.ceiling || [];
    const bucket = thresholdBucket();
    if (active === 'overall') return bucket.overall || [];
    return bucket.byStrategy?.[active] || [];
  }

  function renderDrafts() {
    const rows = rowsForActiveFilter();
    if (!rows.length) {
      const copy = active === 'ceiling'
        ? 'No isolated ceiling outcomes are available in this run.'
        : `No stored ${active === 'overall' ? 'overall' : active.replaceAll('_', ' ')} drafts met a ${minimumAvailability}% minimum through Round ${floorMaxRound}. Try the next lower threshold.`;
      drafts.innerHTML = `<div class="simulation-empty"><b>No matching drafts.</b><span>${esc(copy)}</span></div>`;
      return;
    }
    drafts.innerHTML = rows.map(draftCard).join('');
  }

  function renderFilters() {
    const bucket = thresholdBucket();
    const summaryById = new Map(data.strategySummary.map(row => [row.id, row]));
    const button = (id, label, count) => `<button class="simulation-filter ${active === id ? 'active' : ''}" type="button" data-simulation-filter="${esc(id)}" aria-pressed="${active === id}">${esc(label)}<span>${num(count)}</span></button>`;
    filters.innerHTML = button('overall', `Best at ${minimumAvailability}%+`, bucket.overall?.length || 0)
      + Object.keys(bucket.byStrategy || {}).map(id => button(id, summaryById.get(id)?.shortLabel || id, bucket.byStrategy[id]?.length || 0)).join('')
      + button('ceiling', 'Ceiling outcomes', data.ceiling?.length || 0);
  }

  function renderThresholds() {
    if (!thresholds || !data) return;
    const values = data.meta.availabilityThresholds || Object.keys(data.thresholds || {}).map(Number).sort((a, b) => a - b);
    const ceilingActive = active === 'ceiling';
    thresholds.innerHTML = values.map(value => {
      const bucket = data.thresholds?.[String(value)];
      const selected = value === minimumAvailability;
      const label = value === 0 ? 'Any floor' : `${value}%+`;
      return `<button class="simulation-threshold ${selected ? 'active' : ''}" type="button"
        data-availability-threshold="${value}" aria-pressed="${selected}" ${ceilingActive ? 'disabled' : ''}>
        <b>${esc(label)}</b><small>${num(bucket?.eligibleDrafts || 0)} drafts</small>
      </button>`;
    }).join('');

    thresholdPanel?.classList.toggle('disabled', ceilingActive);
    const bucket = thresholdBucket();
    if (thresholdSummary) {
      thresholdSummary.textContent = ceilingActive
        ? 'Availability floors are intentionally paused for the separate ceiling-outcomes list.'
        : `${num(bucket.eligibleDrafts || 0)} threshold-aware drafts kept every QB, RB, WR, and TE selection in Rounds 1–${floorMaxRound} at or above ${minimumAvailability}%. Rounds ${floorMaxRound + 1}–14 are late bench exceptions; DEF and K are excluded.`;
    }
  }

  function renderMethod() {
    const m = data.meta;
    const props = Number(m.marketPropPlayers || 0) > 0
      ? `${num(m.marketPropPlayers)} players had market-prop inputs in this run.`
      : 'No player-prop market feed was available in this run, so rankings use the current projection ensemble, floors, ceilings, consensus ranks, and exact-format ADP.';
    method.innerHTML = `<h2>How these drafts are ranked</h2><p>${esc(m.simulationMethod)}</p><p>${esc(m.rankingMethod)}</p><p>${esc(m.displayPolicy || '')}</p><p>${esc(props)}</p><small>The availability-floor control is a hard filter through Round ${floorMaxRound}: at ${minimumAvailability}%, every displayed QB, RB, WR, and TE selected in Rounds 1–${floorMaxRound} had at least a ${minimumAvailability}% modeled chance of reaching that exact pick. Rounds ${floorMaxRound + 1}–14 are exempt because they are late bench dart throws and the current ADP source does not provide enough deeper skill players for a meaningful 35% floor there. DEF and K are also excluded.</small>`;
  }

  function chooseFilter(id) {
    active = id;
    renderThresholds();
    renderFilters();
    renderDrafts();
    renderMethod();
    document.querySelector('#ranked-drafts-heading')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function chooseThreshold(value) {
    minimumAvailability = Number(value);
    renderThresholds();
    renderFilters();
    renderDrafts();
    renderMethod();
  }

  if (!data) {
    document.querySelector('[data-app-panel="simulations"]').innerHTML = '<div class="simulation-empty"><b>Simulation results did not load.</b><span>Refresh after deployment completes.</span></div>';
    return;
  }

  const m = data.meta;
  badge.textContent = num(m.totalCompletedDrafts);
  meta.innerHTML = `<span><b>${num(m.totalCompletedDrafts)}</b><small>complete draft paths</small></span>
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

  filters.addEventListener('click', event => {
    const target = event.target.closest('[data-simulation-filter]');
    if (target) chooseFilter(target.dataset.simulationFilter);
  });
  thresholds?.addEventListener('click', event => {
    const target = event.target.closest('[data-availability-threshold]');
    if (target && !target.disabled) chooseThreshold(target.dataset.availabilityThreshold);
  });
  strategies.addEventListener('click', event => {
    const target = event.target.closest('[data-strategy-jump]');
    if (target) chooseFilter(target.dataset.strategyJump);
  });

  renderThresholds();
  renderFilters();
  renderDrafts();
  renderMethod();
})();
