(() => {
  'use strict';

  const Engine = window.DraftEngine;
  const Availability = window.DraftAvailability;
  const pool = Array.isArray(window.players) ? window.players : [];
  const meta = window.draftMeta || {};
  const STORAGE_KEY = 'pick9-expected-board-ux-v2';
  const UX_VERSION = 'expected-board-ux-v2';
  const byKey = new Map(pool.map(player => [player.key, player]));
  const starterTargets = { QB: 1, RB: 2, WR: 2, TE: 1 };

  let state = {
    selected: [],
    more: 0,
    teamOpen: false,
    showFullPath: false
  };
  let history = [];
  let renderToken = 0;

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state = { ...state, ...saved };
  } catch (_) {
    state = { selected: [], more: 0, teamOpen: false, showFullPath: false };
  }

  state.selected = (state.selected || []).filter(key => byKey.has(key));
  state.more = Number.isFinite(Number(state.more)) ? Math.max(0, Number(state.more)) : 0;
  state.teamOpen = Boolean(state.teamOpen);
  state.showFullPath = Boolean(state.showFullPath);

  const elements = {
    live: document.querySelector('#live-status'),
    calculating: document.querySelector('#calculating'),
    roundLabel: document.querySelector('#round-label'),
    pickLabel: document.querySelector('#pick-label'),
    progressBar: document.querySelector('#progress-bar'),
    rosterChips: document.querySelector('#roster-chips'),
    undo: document.querySelector('#undo'),
    reset: document.querySelector('#reset'),
    sourceNote: document.querySelector('#source-note'),
    construction: document.querySelector('#construction'),
    teamToggle: document.querySelector('#team-toggle'),
    teamToggleLabel: document.querySelector('#team-toggle-label'),
    teamBody: document.querySelector('#team-body'),
    draftPath: document.querySelector('#draft-path'),
    board: document.querySelector('#board-shell')
  };

  document.documentElement.dataset.uxVersion = UX_VERSION;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function roster() {
    return state.selected.map(key => byKey.get(key)).filter(Boolean);
  }

  function currentRound() {
    return state.selected.length + 1;
  }

  function pickNumber(round) {
    return Engine?.PICKS?.[round - 1] ?? [9, 20, 37, 48, 65, 76, 93, 104, 121, 132, 149, 160, 177, 188, 205, 216][round - 1];
  }

  function pickLabel(round) {
    return `${round}.${String(round % 2 ? 9 : 6).padStart(2, '0')}`;
  }

  function counts(currentRoster = roster()) {
    if (Engine?.counts) return Engine.counts(currentRoster);
    const result = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
    currentRoster.forEach(player => {
      if (result[player.pos] !== undefined) result[player.pos] += 1;
    });
    return result;
  }

  function construction(currentRoster = roster()) {
    if (!currentRoster.length) return 'No picks yet';
    const visible = currentRoster.slice(-3).map(player => player.name.split(' ').at(-1)).join(' · ');
    const earlier = Math.max(0, currentRoster.length - 3);
    return `${visible}${earlier ? ` +${earlier}` : ''}`;
  }

  function selectedBlockedSet() {
    const blocked = new Set();
    state.selected.forEach(key => {
      blocked.add(key);
      const player = byKey.get(key);
      if (player) blocked.add(player.id);
    });
    return blocked;
  }

  function availabilityAtPick(player, round = currentRound()) {
    const pick = pickNumber(round);
    if (!pick) return 0.5;
    if (Availability?.probabilityAtPick) return Availability.probabilityAtPick(player, pick);
    return 0.5;
  }

  function availabilityInfo(player, round = currentRound()) {
    const pick = pickNumber(round);
    if (Availability?.annotate) {
      return Availability.annotate({ player, details: {} }, pick).availability;
    }
    const probability = availabilityAtPick(player, round);
    return {
      probability,
      key: probability >= 0.72 ? 'likely' : probability >= 0.46 ? 'range' : probability >= 0.22 ? 'possible' : 'longshot',
      text: probability >= 0.72 ? 'Likely there' : probability >= 0.46 ? 'In range' : probability >= 0.22 ? 'Possible faller' : 'Long-shot faller',
      range: { early: Math.max(1, Math.round((finite(player.adp) ?? pick) - 8)), late: Math.round((finite(player.adp) ?? pick) + 8) }
    };
  }

  function playerEligible(player, round, currentRoster) {
    if (!player || player.excluded || state.selected.includes(player.key)) return false;
    if (Engine?.isEligible) return Engine.isEligible(player, currentRoster, round);
    const c = counts(currentRoster);
    if (round === 15) return player.pos === 'DEF';
    if (round === 16) return player.pos === 'K';
    if (['DEF', 'K'].includes(player.pos)) return false;
    if (round <= 2 && !['RB', 'WR'].includes(player.pos)) return false;
    if (c.QB >= 1 && player.pos === 'QB' && round < 13) return false;
    if (c.TE >= 1 && player.pos === 'TE' && round < 12) return false;
    return true;
  }

  function ensembleRank(player) {
    const direct = finite(player.ensembleRank);
    if (direct !== null && direct > 0) return direct;
    const values = [player.adp, player.valueRank, player.consensusRank, player.rotowireRank, player.marketPropRank]
      .map(finite)
      .filter(value => value !== null && value > 0)
      .sort((first, second) => first - second);
    return values.length ? values[Math.floor(values.length / 2)] : finite(player.adp) ?? 999;
  }

  function projectedPoints(player) {
    return finite(player.projectionEnsemble)
      ?? finite(player.marketPropProjection)
      ?? finite(player.lineupBeatProjection)
      ?? finite(player.projection);
  }

  function fallbackScore(player, round, currentRoster) {
    const c = counts(currentRoster);
    const pick = pickNumber(round);
    let score = -ensembleRank(player) + clamp((pick - (finite(player.adp) ?? pick)) * 0.42, -12, 12);
    if (round <= 4) {
      if (player.pos === 'RB' && c.RB < 2) score += 18;
      if (player.pos === 'WR' && c.WR < 2) score += 18;
    }
    if (round >= 5 && player.pos === 'WR' && c.WR < 3) score += 8;
    if (round >= 6 && player.pos === 'QB' && c.QB < 1) score += 10 + (round - 6) * 7;
    if (round >= 7 && player.pos === 'TE' && c.TE < 1) score += 8 + (round - 7) * 7;
    if (round >= 9 && ['RB', 'WR'].includes(player.pos)) score += 4;
    if (round === 15 && player.pos === 'DEF') score += 100;
    if (round === 16 && player.pos === 'K') score += 100;
    return score;
  }

  function rankedEntries(round = currentRound(), currentRoster = roster()) {
    const blocked = selectedBlockedSet();
    const modelBlocked = new Set(blocked);
    const minimumModeledAvailability = round <= 4 ? 0.05 : 0.035;

    pool.forEach(player => {
      if (!playerEligible(player, round, currentRoster)) return;
      if (availabilityAtPick(player, round) < minimumModeledAvailability) {
        modelBlocked.add(player.key);
        modelBlocked.add(player.id);
      }
    });

    try {
      if (!Engine?.rankPlayers) throw new Error('Recommendation engine unavailable');
      const ranked = Engine.rankPlayers(pool, modelBlocked, currentRoster, round);
      if (!Array.isArray(ranked) || !ranked.length) throw new Error('No recommendations returned');
      return {
        fallback: false,
        entries: ranked.map(entry => ({
          ...entry,
          availability: availabilityInfo(entry.player, round)
        }))
      };
    } catch (error) {
      const entries = pool
        .filter(player => !blocked.has(player.key) && playerEligible(player, round, currentRoster))
        .map(player => ({
          player,
          details: {
            total: fallbackScore(player, round, currentRoster),
            optimized: false,
            confidence: 'Fallback board'
          },
          availability: availabilityInfo(player, round)
        }))
        .sort((first, second) => second.details.total - first.details.total || first.player.adp - second.player.adp);
      return { fallback: true, error, entries };
    }
  }

  function sourceText() {
    const draftCount = finite(meta.draftCount)?.toLocaleString() || 'Current';
    const dateText = meta.endDate || meta.generatedAt?.slice?.(0, 10) || 'current';
    const inputs = [
      finite(meta.lineupBeatMatches) ? `${meta.lineupBeatMatches} independent projections` : '',
      finite(meta.marketPropMatches) ? `${meta.marketPropMatches} market-priced projections` : '',
      finite(meta.consensusMatches) ? `${meta.consensusMatches} consensus ranks` : ''
    ].filter(Boolean).join(' · ');
    return `${draftCount} recent 14-team half-PPR mocks through ${dateText}${inputs ? ` · ${inputs}` : ''} · availability is estimated, not live`;
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  function snapshot() {
    history.push(JSON.stringify(state));
    if (history.length > 50) history.shift();
    elements.undo.disabled = false;
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
    if (elements.calculating) {
      elements.calculating.hidden = !busy;
      elements.calculating.querySelector('b').textContent = message;
    }
    if (busy) announce(message);
  }

  function renderHeader(currentRoster, round) {
    const complete = round > 16;
    elements.roundLabel.textContent = complete ? 'Draft complete' : `Round ${round} of 16`;
    elements.pickLabel.textContent = complete
      ? `${currentRoster.length} players selected`
      : `Pick ${pickLabel(round)} · #${pickNumber(round)}`;
    elements.progressBar.style.width = `${Math.min(100, currentRoster.length / 16 * 100)}%`;
    elements.undo.disabled = history.length === 0;

    const c = counts(currentRoster);
    elements.rosterChips.innerHTML = ['QB', 'RB', 'WR', 'TE']
      .map(position => {
        const value = c[position] || 0;
        const target = starterTargets[position];
        const stateClass = value >= target ? 'filled' : value > 0 ? 'partial' : 'need';
        return `<span class="roster-chip ${stateClass}">${position} <b>${value}/${target}</b></span>`;
      })
      .join('')
      + `<span class="roster-chip">Bench <b>${Math.max(0, currentRoster.length - Math.min(c.QB, 1) - Math.min(c.RB, 2) - Math.min(c.WR, 2) - Math.min(c.TE, 1))}</b></span>`;
  }

  function renderTeam(currentRoster) {
    elements.construction.textContent = construction(currentRoster);
    elements.teamToggle.setAttribute('aria-expanded', String(state.teamOpen));
    elements.teamToggleLabel.textContent = state.teamOpen ? 'Hide roster' : 'Show roster';
    elements.teamBody.hidden = !state.teamOpen;
    elements.teamBody.innerHTML = currentRoster.length
      ? `<div class="team-grid">${currentRoster.map((player, index) => `
          <div class="team-row">
            <span class="round-badge">R${index + 1}</span>
            <span class="team-player"><b>${escapeHtml(player.name)}</b><small>${player.pos}${player.team ? ` · ${escapeHtml(player.team)}` : ''}${player.bye ? ` · Bye ${player.bye}` : ''}</small></span>
          </div>`).join('')}</div>`
      : '<div class="team-empty">Your selections will appear here automatically.</div>';
  }

  function pathNode(player, index) {
    const round = index + 1;
    return `<div class="path-node">
      <div class="path-round"><b>R${round}</b>${pickLabel(round)}</div>
      <div class="path-player"><b>${escapeHtml(player.name)}</b><small>${player.pos}${player.team ? ` · ${escapeHtml(player.team)}` : ''} · Pick #${pickNumber(round)}</small></div>
      <button class="change-pick" type="button" data-change-index="${index}" aria-label="Change Round ${round} pick ${escapeHtml(player.name)}">Change</button>
    </div>`;
  }

  function renderPath(currentRoster) {
    if (!currentRoster.length) {
      elements.draftPath.innerHTML = '';
      return;
    }
    const visibleStart = state.showFullPath ? 0 : Math.max(0, currentRoster.length - 4);
    const hiddenCount = visibleStart;
    elements.draftPath.innerHTML = `
      ${hiddenCount ? `<button class="more-button path-more" id="show-full-path" type="button">Show ${hiddenCount} earlier pick${hiddenCount === 1 ? '' : 's'}</button>` : ''}
      ${currentRoster.slice(visibleStart).map((player, offset) => pathNode(player, visibleStart + offset)).join('')}`;

    elements.draftPath.querySelectorAll('[data-change-index]').forEach(button => {
      button.addEventListener('click', () => reopenRound(Number(button.dataset.changeIndex)));
    });
    document.querySelector('#show-full-path')?.addEventListener('click', () => {
      state.showFullPath = true;
      save();
      renderPath(roster());
    });
  }

  function rosterFit(player, currentRoster, round, index) {
    const c = counts(currentRoster);
    if (index === 0) return 'Best roster-adjusted option expected at this pick';
    if (player.pos === 'RB' && c.RB < 2) return `Fills your ${c.RB === 0 ? 'RB1' : 'RB2'} slot before the position thins`;
    if (player.pos === 'WR' && c.WR < 2) return `Fills your ${c.WR === 0 ? 'WR1' : 'WR2'} slot`;
    if (player.pos === 'WR' && c.WR < 3) return 'Adds a FLEX-caliber receiver';
    if (player.pos === 'QB' && c.QB < 1) return 'Secures your starting quarterback in the right window';
    if (player.pos === 'TE' && c.TE < 1) return 'Fills tight end without sacrificing early RB/WR depth';
    if (ensembleRank(player) <= pickNumber(round) - 6) return 'Strong value relative to this selection';
    return 'Strong combination of value, fit, and future-round flexibility';
  }

  function splitBoard(entries, round) {
    if (round >= 15) return { fallers: [], expected: entries };
    const pick = pickNumber(round);
    const fallers = entries
      .filter(entry => {
        const rank = ensembleRank(entry.player);
        return entry.availability.probability < 0.46 && rank <= pick - 2;
      })
      .slice(0, 4 + Math.floor(state.more / 4));

    const fallerKeys = new Set(fallers.map(entry => entry.player.key));
    let expected = entries.filter(entry =>
      !fallerKeys.has(entry.player.key) && entry.availability.probability >= 0.22
    );

    if (expected.length < 6) {
      const used = new Set([...fallerKeys, ...expected.map(entry => entry.player.key)]);
      expected = [
        ...expected,
        ...entries.filter(entry => !used.has(entry.player.key))
      ];
    }
    return { fallers, expected };
  }

  function availabilityBadge(availability) {
    const probability = Math.round(availability.probability * 100);
    const labelClass = availability.key === 'range' ? 'good' : availability.key;
    return `<span class="availability ${labelClass}" data-availability="${probability}">${escapeHtml(availability.text)} ${probability}%</span>`;
  }

  function playerStats(player, entry) {
    const stats = [];
    const adp = finite(player.adp);
    const rank = ensembleRank(player);
    const projection = projectedPoints(player);
    if (adp !== null) stats.push(`ADP ${adp.toFixed(1)}`);
    if (Number.isFinite(rank)) stats.push(`Model #${rank.toFixed(1)}`);
    if (projection !== null && projection > 0) stats.push(`${projection.toFixed(0)} projected pts`);
    if (entry.details?.optimized && finite(entry.details.rollouts)) stats.push(`${entry.details.rollouts} board sims`);
    return stats;
  }

  function expectedCard(entry, index, round, currentRoster) {
    const player = entry.player;
    const note = player.statusNote
      ? `<div class="player-note"><b>${escapeHtml(player.status || 'Note')}:</b> ${escapeHtml(player.statusNote)}</div>`
      : '';
    const stats = playerStats(player, entry);
    const closeCall = entry.details?.confidence === 'Close alternative' || entry.details?.confidence === 'Close call';

    return `<button class="player-card ${index === 0 ? 'model-pick' : ''} ${closeCall ? 'close-call' : ''}" type="button" data-draft-key="${escapeHtml(player.key)}" data-player-name="${escapeHtml(player.name)}" aria-label="Draft ${escapeHtml(player.name)}">
      <div class="card-top">
        <span class="option-rank">${index + 1}</span>
        <span class="player-info"><b>${escapeHtml(player.name)}</b><small>${player.pos}${player.team ? ` · ${escapeHtml(player.team)}` : ''}${player.bye ? ` · Bye ${player.bye}` : ''}</small></span>
        <span class="model-label">${index === 0 ? 'Model pick' : 'Option'}</span>
      </div>
      <div class="card-middle">
        <span class="fit-copy">${escapeHtml(rosterFit(player, currentRoster, round, index))}</span>
        ${availabilityBadge(entry.availability)}
      </div>
      <div class="card-stats">${stats.map(stat => `<span>${escapeHtml(stat)}</span>`).join('')}</div>
      ${note}
      <span class="select-cue">Tap anywhere on this card to draft</span>
    </button>`;
  }

  function fallerCard(entry, round) {
    const player = entry.player;
    const probability = Math.round(entry.availability.probability * 100);
    return `<button class="faller-card" type="button" data-draft-key="${escapeHtml(player.key)}" data-player-name="${escapeHtml(player.name)}" aria-label="Draft premium faller ${escapeHtml(player.name)}">
      <span class="faller-label">SMASH<br>IF THERE</span>
      <span class="faller-player"><b>${escapeHtml(player.name)}</b><small>${player.pos}${player.team ? ` · ${escapeHtml(player.team)}` : ''} · ADP ${finite(player.adp)?.toFixed(1) ?? '—'}</small></span>
      <span class="faller-chance" data-availability="${probability}">${probability}%</span>
    </button>`;
  }

  function boardLoading(round) {
    return `<div class="board-loading"><span class="spinner" aria-hidden="true"></span><div><strong>Building your Round ${round} board…</strong><small>Estimating who should reach pick #${pickNumber(round)}</small></div></div>`;
  }

  function boardMarkup(model, round, currentRoster) {
    const { fallers, expected } = splitBoard(model.entries, round);
    const baseCount = round === 1 ? 8 : 6;
    const shown = expected.slice(0, baseCount + state.more);
    const plan = Engine?.plan ? Engine.plan(round, currentRoster) : 'Best available value for your roster';
    const fallerMarkup = fallers.length ? `
      <div class="section-heading"><div><span>Check premium fallers first</span><small>Unlikely to reach you, but priority picks when they do.</small></div><em>${fallers.length} to scan</em></div>
      <div class="faller-list">${fallers.map(entry => fallerCard(entry, round)).join('')}</div>` : '';
    const fallback = model.fallback
      ? '<div class="player-note"><b>Fallback board:</b> The full lookahead model did not load, so this round is ranked by ADP, roster need, and positional value.</div>'
      : '';

    return `<div class="board-panel" id="current-board">
      <div class="board-head">
        <div><span class="board-kicker">EXPECTED AVAILABILITY BOARD</span><h2>Round ${round} · Pick #${pickNumber(round)}</h2><p>${escapeHtml(plan)}. No opponent picks need to be entered.</p></div>
        <span class="no-track-badge">TAP ONLY YOUR PICK</span>
      </div>
      <div class="board-summary"><span>${shown.length} ranked options</span><span>${fallers.length} fallers to check</span><span>Market-estimated availability</span></div>
      ${fallback}
      ${fallerMarkup}
      <div class="section-heading"><div><span>Best options expected at your turn</span><small>Ranked for the team you have already drafted.</small></div><em>Ignore names already gone</em></div>
      <div class="recommendation-list">${shown.map((entry, index) => expectedCard(entry, index, round, currentRoster)).join('')}</div>
      ${shown.length < expected.length ? `<button class="more-button" id="show-more" type="button">Show ${Math.min(6, expected.length - shown.length)} more expected options</button>` : ''}
      <p class="board-footnote">This intentionally does not track the other 13 teams. Availability percentages come from recent 14-team half-PPR draft-position distributions. Select the highest-ranked displayed player who is actually available in your room.</p>
    </div>`;
  }

  function completionMarkup(currentRoster) {
    return `<div class="completion-card"><h2>Draft complete</h2><p>${currentRoster.length} selections are saved on this device.</p><button id="show-final-roster" type="button">Show final roster</button></div>`;
  }

  function bindBoard() {
    elements.board.querySelectorAll('[data-draft-key]').forEach(button => {
      button.addEventListener('click', () => selectPlayer(button.dataset.draftKey));
    });
    document.querySelector('#show-more')?.addEventListener('click', () => {
      snapshot();
      state.more += 6;
      save();
      render();
      announce('More expected options shown.');
    });
    document.querySelector('#show-final-roster')?.addEventListener('click', () => {
      state.teamOpen = true;
      save();
      renderTeam(roster());
      elements.teamToggle.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function scrollBoardIntoView() {
    window.setTimeout(() => {
      const board = document.querySelector('#current-board') || elements.board;
      const headerHeight = document.querySelector('.app-header')?.offsetHeight || 0;
      const top = board.getBoundingClientRect().top + window.scrollY - headerHeight - 8;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }, 40);
  }

  function render({ scroll = false } = {}) {
    const token = ++renderToken;
    const currentRoster = roster();
    const round = currentRound();

    document.body.classList.toggle('has-picks', currentRoster.length > 0);
    renderHeader(currentRoster, round);
    renderTeam(currentRoster);
    renderPath(currentRoster);
    elements.sourceNote.textContent = sourceText();
    elements.undo.disabled = history.length === 0;

    if (round > 16) {
      elements.board.setAttribute('aria-busy', 'false');
      elements.board.innerHTML = completionMarkup(currentRoster);
      bindBoard();
      setBusy(false);
      if (scroll) scrollBoardIntoView();
      return;
    }

    elements.board.setAttribute('aria-busy', 'true');
    elements.board.innerHTML = boardLoading(round);
    setBusy(true, `Building your Round ${round} board`);

    requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (token !== renderToken) return;
        const model = rankedEntries(round, currentRoster);
        if (token !== renderToken) return;
        elements.board.innerHTML = boardMarkup(model, round, currentRoster);
        elements.board.setAttribute('aria-busy', 'false');
        bindBoard();
        setBusy(false);
        announce(`Round ${round} recommendations are ready.`);
        if (scroll) scrollBoardIntoView();
      }, 0);
    });
  }

  function selectPlayer(playerKey) {
    const player = byKey.get(playerKey);
    if (!player || state.selected.includes(playerKey)) return;
    snapshot();
    state.selected.push(playerKey);
    state.more = 0;
    state.teamOpen = false;
    state.showFullPath = false;
    save();
    render({ scroll: true });
    announce(`${player.name} added. Building Round ${currentRound()} recommendations.`);
  }

  function reopenRound(index) {
    snapshot();
    state.selected = state.selected.slice(0, index);
    state.more = 0;
    state.showFullPath = false;
    save();
    render({ scroll: true });
    announce(`Round ${index + 1} reopened.`);
  }

  elements.teamToggle.addEventListener('click', () => {
    state.teamOpen = !state.teamOpen;
    save();
    renderTeam(roster());
  });

  elements.undo.addEventListener('click', () => {
    if (!history.length) return;
    state = JSON.parse(history.pop());
    state.selected = (state.selected || []).filter(key => byKey.has(key));
    save();
    render({ scroll: true });
    announce('Last action undone.');
  });

  elements.reset.addEventListener('click', () => {
    if (!window.confirm('Reset all 16 draft selections?')) return;
    snapshot();
    state = { selected: [], more: 0, teamOpen: false, showFullPath: false };
    save();
    render({ scroll: true });
    announce('Draft reset to Round 1.');
  });

  window.__pick9App = {
    version: UX_VERSION,
    getState: () => JSON.parse(JSON.stringify(state)),
    availabilityAtPick,
    currentRound,
    getBoard: () => rankedEntries(currentRound(), roster()),
    reset: () => {
      state = { selected: [], more: 0, teamOpen: false, showFullPath: false };
      history = [];
      save();
      render();
    }
  };

  if (!pool.length || !Engine || !Availability) {
    elements.board.setAttribute('aria-busy', 'false');
    elements.board.innerHTML = '<div class="completion-card"><h2>The board could not load</h2><p>Refresh the page. Your saved picks will remain on this device.</p></div>';
    setBusy(false);
  } else {
    render();
  }
})();
