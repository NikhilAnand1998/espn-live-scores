(() => {
  'use strict';

  const Engine = window.DraftEngine;
  const Availability = window.DraftAvailability;
  const pool = Array.isArray(window.players) ? window.players : [];
  const meta = window.draftMeta || {};
  const storageKey = 'pick9-adversarial-ux-v3';
  const byKey = new Map(pool.map(player => [player.key, player]));

  let state = { selected: [], more: 0 };
  let history = [];
  let pathExpanded = false;

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    state = { ...state, ...saved };
  } catch (_) {}

  state.selected = (state.selected || []).filter(key => byKey.has(key));

  const elements = {
    roundLabel: document.querySelector('#round-label'),
    pickLabel: document.querySelector('#pick-label'),
    progressBar: document.querySelector('#progress-bar'),
    rosterChips: document.querySelector('#roster-chips'),
    undo: document.querySelector('#undo'),
    reset: document.querySelector('#reset'),
    intro: document.querySelector('#intro'),
    sourceNote: document.querySelector('#source-note'),
    construction: document.querySelector('#construction'),
    teamToggle: document.querySelector('#team-toggle'),
    teamToggleLabel: document.querySelector('#team-toggle-label'),
    teamBody: document.querySelector('#team-body'),
    draftPath: document.querySelector('#draft-path'),
    board: document.querySelector('#board-shell'),
    live: document.querySelector('#live-status')
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function roster() {
    return state.selected.map(key => byKey.get(key)).filter(Boolean);
  }

  function round() {
    return state.selected.length + 1;
  }

  function pickLabel(roundNumber) {
    return `${roundNumber}.${String(roundNumber % 2 ? 9 : 6).padStart(2, '0')}`;
  }

  function blockedKeys() {
    // Only the user's own selections are certain. Unselected players remain in
    // the model so they can reappear as actionable fallers on a later turn.
    return new Set(state.selected);
  }

  function rankedEntries(roundNumber = round(), currentRoster = roster()) {
    const overallPick = Engine.PICKS[roundNumber - 1];
    return Engine
      .rankPlayers(pool, blockedKeys(), currentRoster, roundNumber)
      .map(entry => Availability.annotate(entry, overallPick));
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (_) {}
  }

  function snapshot() {
    history.push(JSON.stringify(state));
    if (history.length > 50) history.shift();
  }

  function announce(message) {
    if (!elements.live) return;
    elements.live.textContent = '';
    requestAnimationFrame(() => { elements.live.textContent = message; });
  }

  function setBusy(busy, message = 'Updating recommendations') {
    document.body.classList.toggle('is-calculating', busy);
    document.body.setAttribute('aria-busy', String(busy));
    elements.board?.setAttribute('aria-busy', String(busy));
    if (busy) announce(message);
  }

  function runBusy(task, message) {
    setBusy(true, message);
    window.setTimeout(() => {
      try {
        task();
      } finally {
        setBusy(false);
      }
    }, 24);
  }

  function compactName(player) {
    const parts = String(player.name || '').split(' ').filter(Boolean);
    return parts.at(-1) || player.name;
  }

  function compactTeamLabel(currentRoster) {
    if (!currentRoster.length) return 'No picks yet';
    const visible = currentRoster.slice(-3).map(compactName).join(' · ');
    const earlier = Math.max(0, currentRoster.length - 3);
    return `${visible}${earlier ? ` +${earlier}` : ''}`;
  }

  function sourceText() {
    const draftCount = Number(meta.draftCount || 0).toLocaleString();
    const dateText = meta.endDate ? `through ${meta.endDate}` : 'current snapshot';
    const projectionText = Number(meta.lineupBeatMatches || 0) > 0
      ? `${meta.lineupBeatMatches} independent projections`
      : 'multi-source projections';
    return `${draftCount || 'Current'} exact-format mocks ${dateText} · ${projectionText} · roster-aware lookahead · ${Availability.version}`;
  }

  function renderHeader(currentRoster, currentRound) {
    const complete = currentRound > 16;
    elements.roundLabel.textContent = complete ? 'Draft complete' : `Round ${currentRound} of 16`;
    elements.pickLabel.textContent = complete
      ? `${currentRoster.length} players selected`
      : `Pick ${pickLabel(currentRound)} · #${Engine.PICKS[currentRound - 1]}`;
    elements.progressBar.style.width = `${Math.min(100, currentRoster.length / 16 * 100)}%`;
    elements.undo.disabled = history.length === 0;

    const counts = Engine.counts(currentRoster);
    elements.rosterChips.innerHTML = ['QB', 'RB', 'WR', 'TE', 'FLEX']
      .map(position => {
        const value = position === 'FLEX'
          ? Math.max(0, counts.RB + counts.WR + counts.TE - 5)
          : counts[position];
        const target = position === 'QB' || position === 'TE' ? 1 : position === 'RB' || position === 'WR' ? 2 : 1;
        const stateClass = value >= target ? 'filled' : value > 0 ? 'partial' : '';
        return `<span class="roster-chip ${stateClass}"><b>${value}</b> ${position}</span>`;
      })
      .join('');
  }

  function renderTeam(currentRoster) {
    elements.construction.textContent = compactTeamLabel(currentRoster);
    if (!currentRoster.length) {
      elements.teamBody.innerHTML = '<p class="empty-team">Your selections will appear here.</p>';
      return;
    }
    elements.teamBody.innerHTML = `
      <ol class="team-list">
        ${currentRoster.map((player, index) => `
          <li>
            <span class="team-round">R${index + 1}</span>
            <span><b>${escapeHtml(player.name)}</b><small>${player.pos} · ${escapeHtml(player.team || '')} · ADP ${Number(player.adp).toFixed(1)}</small></span>
          </li>`).join('')}
      </ol>`;
  }

  function pathNode(player, index) {
    const roundNumber = index + 1;
    return `
      <li class="path-node">
        <span class="path-dot" aria-hidden="true"></span>
        <div class="path-card">
          <span class="path-round">R${roundNumber}<small>${pickLabel(roundNumber)} · #${Engine.PICKS[index]}</small></span>
          <span class="path-player"><b>${escapeHtml(player.name)}</b><small>${player.pos} · ${escapeHtml(player.team || '')}</small></span>
          <button class="path-change" type="button" data-edit="${index}" aria-label="Change Round ${roundNumber} selection">Change</button>
        </div>
      </li>`;
  }

  function renderPath(currentRoster) {
    if (!currentRoster.length) {
      elements.draftPath.innerHTML = `
        <div class="path-start">
          <span class="path-dot" aria-hidden="true"></span>
          <b>Your draft path starts here</b>
          <small>Round 1 recommendations are below.</small>
        </div>`;
      return;
    }

    const hiddenCount = pathExpanded ? 0 : Math.max(0, currentRoster.length - 4);
    const visibleStart = hiddenCount;
    const earlierMarkup = hiddenCount
      ? `<li class="path-earlier"><span class="path-dot" aria-hidden="true"></span><button type="button" id="show-full-path">Show ${hiddenCount} earlier pick${hiddenCount === 1 ? '' : 's'}</button></li>`
      : '';

    elements.draftPath.innerHTML = `
      <ol class="path-list">
        ${earlierMarkup}
        ${currentRoster.slice(visibleStart).map((player, offset) => pathNode(player, visibleStart + offset)).join('')}
      </ol>`;
  }

  function availabilityBadge(availability) {
    const probability = Math.round(availability.probability * 100);
    return `
      <span class="availability-badge ${availability.key}">
        <b>${escapeHtml(availability.text)}</b>
        <small>≈${probability}% · range ${availability.range.early}–${availability.range.late}</small>
      </span>`;
  }

  function modelSummary(entry, index) {
    const player = entry.player;
    const details = entry.details || {};
    const projection = Number(player.projectionEnsemble ?? player.projection);
    const items = [];
    if (Number.isFinite(projection) && projection > 0) items.push(`${projection.toFixed(0)} projected points`);
    if (details.optimized && Number(details.rollouts) > 0) items.push(`${details.rollouts} board paths`);
    if (index === 0 && details.confidence) items.push(details.confidence);
    if (Number.isFinite(details.behindTop) && index > 0) items.push(`${details.behindTop.toFixed(1)} model points behind #1`);
    return items;
  }

  function recommendationCard(entry, index, currentRound, currentRoster) {
    const player = entry.player;
    const reasons = Engine.reasons(entry, currentRoster, currentRound, index).slice(0, 3);
    const nextPlan = currentRound === 16
      ? 'Draft complete'
      : Engine.plan(currentRound + 1, [...currentRoster, player]);
    const summary = modelSummary(entry, index);
    const status = player.status
      ? `<div class="player-alert"><b>${escapeHtml(player.status)}</b>${player.statusNote ? ` · ${escapeHtml(player.statusNote)}` : ''}</div>`
      : '';

    return `
      <article class="recommendation-card ${index === 0 ? 'primary' : ''}" data-recommendation-card data-player-name="${escapeHtml(player.name)}">
        <div class="recommendation-head">
          <span class="position-badge">${player.pos}</span>
          <span class="player-identity">
            <b>${escapeHtml(player.name)}</b>
            <small>${escapeHtml(player.team || '')}${player.bye ? ` · Bye ${player.bye}` : ''} · ADP ${Number(player.adp).toFixed(1)}</small>
          </span>
          <span class="choice-rank">${index === 0 ? 'BEST EXPECTED' : `#${index + 1}`}</span>
        </div>
        <div class="recommendation-status">${availabilityBadge(entry.availability)}</div>
        ${summary.length ? `<div class="model-summary">${summary.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
        <div class="reason-list">${reasons.map(reason => `<span>${escapeHtml(reason)}</span>`).join('')}</div>
        ${status}
        <p class="next-plan"><b>Next branch:</b> ${escapeHtml(nextPlan)}</p>
        <button class="draft-player" type="button" data-pick="${escapeHtml(player.key)}">Draft ${escapeHtml(player.name)}</button>
      </article>`;
  }

  function fallerButton(entry, currentRound) {
    const player = entry.player;
    const probability = Math.round(entry.availability.probability * 100);
    return `
      <button class="faller-button" type="button" data-pick="${escapeHtml(player.key)}" data-player-name="${escapeHtml(player.name)}">
        <span class="position-badge">${player.pos}</span>
        <span><b>${escapeHtml(player.name)}</b><small>≈${probability}% chance at #${Engine.PICKS[currentRound - 1]}</small></span>
        <strong>Draft if there</strong>
      </button>`;
  }

  function splitBoard(entries, currentRound) {
    if (currentRound >= 15) return { fallers: [], expected: entries };
    const overallPick = Engine.PICKS[currentRound - 1];
    const modelRank = entry => Number(entry.player.ensembleRank ?? entry.player.valueRank ?? entry.player.adp);
    const lateGap = entry => Math.max(0, overallPick - Number(entry.availability.range?.late || entry.player.adp));

    const allFallers = entries.filter(entry =>
      entry.availability.probability < 0.48 && modelRank(entry) <= overallPick - 2
    );

    // Draft night needs plausible, decision-relevant fallers rather than four
    // nearly impossible superstars crowding out players from the prior tier.
    const actionable = [...allFallers].sort((a, b) =>
      lateGap(a) - lateGap(b)
      || b.availability.probability - a.availability.probability
      || modelRank(a) - modelRank(b)
    );
    const dream = [...allFallers].sort((a, b) => modelRank(a) - modelRank(b))[0];
    const fallers = [];
    for (const entry of [...actionable.slice(0, 5), dream].filter(Boolean)) {
      if (!fallers.some(existing => existing.player.key === entry.player.key)) fallers.push(entry);
    }

    const fallerKeys = new Set(fallers.map(entry => entry.player.key));
    let expected = entries.filter(entry =>
      !fallerKeys.has(entry.player.key) && entry.availability.probability >= 0.22
    );
    if (expected.length < 6) {
      const used = new Set([...fallerKeys, ...expected.map(entry => entry.player.key)]);
      expected = [...expected, ...entries.filter(entry => !used.has(entry.player.key))];
    }
    return { fallers: fallers.slice(0, 6), expected };
  }

  function renderBoard(currentRoster, currentRound) {
    if (currentRound > 16) {
      elements.board.innerHTML = `
        <section class="draft-complete">
          <div class="complete-icon" aria-hidden="true">✓</div>
          <h2>Draft complete</h2>
          <p>Your 16-player roster is saved on this device.</p>
        </section>`;
      elements.board.setAttribute('aria-busy', 'false');
      return;
    }

    const entries = rankedEntries(currentRound, currentRoster);
    const { fallers, expected } = splitBoard(entries, currentRound);
    const baseCount = currentRound === 1 ? 8 : 6;
    const shown = expected.slice(0, baseCount + Number(state.more || 0));
    const firstDetails = shown[0]?.details || fallers[0]?.details || {};
    const simulationText = firstDetails.optimized && firstDetails.rollouts
      ? `${firstDetails.rollouts} future-board paths checked per candidate`
      : 'Projected value, roster fit, and availability combined';

    elements.board.innerHTML = `
      <section class="on-clock" aria-labelledby="board-title">
        <div class="on-clock-copy">
          <span class="eyebrow">YOU ARE ON THE CLOCK</span>
          <h2 id="board-title">Round ${currentRound} · Pick ${pickLabel(currentRound)} · #${Engine.PICKS[currentRound - 1]}</h2>
          <p>${escapeHtml(Engine.plan(currentRound, currentRoster))}. ${escapeHtml(simulationText)}.</p>
        </div>
        <div class="no-tracking-note"><b>Do not enter opponent picks.</b><span>Ignore anyone already drafted and tap your actual selection.</span></div>
      </section>

      ${fallers.length ? `
        <section class="board-section faller-section" aria-labelledby="faller-title">
          <div class="section-title">
            <div><span class="eyebrow">CHECK FIRST</span><h3 id="faller-title">Actionable fallers</h3></div>
            <p>Players from the prior tier who would be strong values if still available.</p>
          </div>
          <div class="faller-grid">${fallers.map(entry => fallerButton(entry, currentRound)).join('')}</div>
        </section>` : ''}

      <section class="board-section expected-section" aria-labelledby="expected-title">
        <div class="section-title">
          <div><span class="eyebrow">EXPECTED AT YOUR TURN</span><h3 id="expected-title">Best choices for your roster</h3></div>
          <p>Tap the highest-ranked option still available in your real draft.</p>
        </div>
        <div class="recommendation-grid">${shown.map((entry, index) => recommendationCard(entry, index, currentRound, currentRoster)).join('')}</div>
        ${shown.length < expected.length ? '<button class="show-more" id="show-more" type="button">Show 4 more possibilities</button>' : ''}
      </section>`;
    elements.board.setAttribute('aria-busy', 'false');
  }

  function render({ scroll = false } = {}) {
    const currentRoster = roster();
    const currentRound = round();
    renderHeader(currentRoster, currentRound);
    renderTeam(currentRoster);
    renderPath(currentRoster);
    renderBoard(currentRoster, currentRound);
    elements.sourceNote.textContent = sourceText();
    document.body.classList.toggle('draft-started', currentRoster.length > 0);
    if (scroll) scrollBoardIntoView();
  }

  function scrollBoardIntoView() {
    window.setTimeout(() => {
      const headerHeight = document.querySelector('.app-header')?.offsetHeight || 0;
      const top = elements.board.getBoundingClientRect().top + window.scrollY - headerHeight - 10;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, 40);
  }

  function selectPlayer(playerKey) {
    const player = byKey.get(playerKey);
    if (!player) return;
    runBusy(() => {
      const currentRound = round();
      const entries = rankedEntries(currentRound);
      if (!entries.some(entry => entry.player.key === playerKey)) return;
      snapshot();
      state.selected.push(playerKey);
      state.more = 0;
      pathExpanded = false;
      save();
      render({ scroll: true });
      announce(currentRound === 16
        ? `${player.name} drafted. Your draft is complete.`
        : `${player.name} drafted. Round ${currentRound + 1} recommendations are ready.`);
    }, `Drafting ${player.name} and rebuilding the tree`);
  }

  function reopenRound(index) {
    runBusy(() => {
      snapshot();
      state.selected = state.selected.slice(0, index);
      state.more = 0;
      pathExpanded = false;
      save();
      render({ scroll: true });
      announce(`Round ${index + 1} reopened.`);
    }, `Reopening Round ${index + 1}`);
  }

  elements.board.addEventListener('click', event => {
    const pickButton = event.target.closest('[data-pick]');
    if (pickButton && elements.board.contains(pickButton)) {
      selectPlayer(pickButton.dataset.pick);
      return;
    }
    const moreButton = event.target.closest('#show-more');
    if (moreButton) {
      snapshot();
      state.more += 4;
      save();
      render();
      announce('Four more draft possibilities shown.');
    }
  });

  elements.draftPath.addEventListener('click', event => {
    const editButton = event.target.closest('[data-edit]');
    if (editButton) {
      reopenRound(Number(editButton.dataset.edit));
      return;
    }
    if (event.target.closest('#show-full-path')) {
      pathExpanded = true;
      renderPath(roster());
      announce('Full draft path shown.');
    }
  });

  elements.teamToggle.addEventListener('click', () => {
    const expanded = elements.teamToggle.getAttribute('aria-expanded') === 'true';
    elements.teamToggle.setAttribute('aria-expanded', String(!expanded));
    elements.teamBody.hidden = expanded;
    elements.teamToggleLabel.textContent = expanded ? 'Show roster' : 'Hide roster';
  });

  elements.undo.addEventListener('click', () => {
    if (!history.length) return;
    runBusy(() => {
      state = JSON.parse(history.pop());
      pathExpanded = false;
      save();
      render();
      announce('Last action undone.');
    }, 'Undoing the last action');
  });

  elements.reset.addEventListener('click', () => {
    if (!window.confirm('Reset the full draft tree?')) return;
    runBusy(() => {
      snapshot();
      state = { selected: [], more: 0 };
      pathExpanded = false;
      save();
      render({ scroll: true });
      announce('Draft tree reset to Round 1.');
    }, 'Resetting the draft tree');
  });

  if (!pool.length || !Engine || !Availability) {
    elements.board.innerHTML = `
      <section class="draft-complete error-state">
        <h2>The board could not load</h2>
        <p>Refresh the page. The current deployment may be incomplete.</p>
      </section>`;
    elements.board.setAttribute('aria-busy', 'false');
  } else {
    window.setTimeout(() => {
      render();
      setBusy(false);
    }, 0);
  }
})();
