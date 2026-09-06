(() => {
  'use strict';

  const Engine = window.DraftEngine;
  const Availability = window.DraftAvailability;
  const pool = Array.isArray(window.players) ? window.players : [];
  const meta = window.draftMeta || {};
  const storageKey = 'pick9-availability-tree-v5';
  const byKey = new Map(pool.map(player => [player.key, player]));

  let state = { selected: [], retired: [], more: 0 };
  let history = [];

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    state = { ...state, ...saved };
  } catch (_) {}

  state.selected = (state.selected || []).filter(key => byKey.has(key));
  state.retired = (state.retired || []).map(list =>
    (list || []).filter(key => byKey.has(key))
  );

  const $ = selector => document.querySelector(selector);
  const treeEl = $('#tree');
  const statusEl = $('#status');
  const constructionEl = $('#construction');
  const teamEl = $('#team');
  const undoEl = $('#undo');
  const resetEl = $('#reset');
  const sourceEl = $('#source-note');
  const liveEl = $('#live-status');

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

  function currentRound() {
    return state.selected.length + 1;
  }

  function pickLabel(round) {
    return `${round}.${String(round % 2 ? 9 : 6).padStart(2, '0')}`;
  }

  function blockedKeys() {
    return new Set([
      ...state.selected,
      ...(state.retired || []).flat()
    ]);
  }

  function rawRankings(round = currentRound(), currentRoster = roster()) {
    return Engine.rankPlayers(pool, blockedKeys(), currentRoster, round);
  }

  function rankings(round = currentRound(), currentRoster = roster()) {
    const pick = Engine.PICKS[round - 1];
    return rawRankings(round, currentRoster).map(entry => Availability.annotate(entry, pick));
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
    if (!liveEl) return;
    liveEl.textContent = '';
    requestAnimationFrame(() => { liveEl.textContent = message; });
  }

  function setBusy(busy, message = 'Updating recommendations') {
    document.body.classList.toggle('is-calculating', busy);
    document.body.setAttribute('aria-busy', String(busy));
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

  function scrollToBranch() {
    const branch = $('#branch');
    if (!branch) return;
    branch.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => {
      const headerHeight = $('header')?.offsetHeight || 0;
      window.scrollBy({ top: -(headerHeight + 8), behavior: 'instant' });
    }, 180);
  }

  function sourceText() {
    const draftCount = Number(meta.draftCount || 0).toLocaleString();
    const dateText = meta.endDate ? `through ${meta.endDate}` : (meta.generatedAt || 'current');
    const external = [
      meta.lineupBeatMatches ? `${meta.lineupBeatMatches} independent projections` : '',
      meta.marketPropMatches ? `${meta.marketPropMatches} market-priced projections` : '',
      meta.rotowireMatches ? `${meta.rotowireMatches} expert ranks` : ''
    ].filter(Boolean).join(' · ');
    return `${draftCount || 'Current'} exact-format mocks ${dateText} · ${external || 'multi-source player model'} · ${Engine.MODEL_LABEL || 'lookahead optimizer'} · ${Availability.version}`;
  }

  function compactTeamLabel(currentRoster) {
    if (!currentRoster.length) return 'No picks yet';
    const names = currentRoster.slice(-3).map(player => {
      const parts = player.name.split(' ');
      return parts.at(-1) || player.name;
    });
    return `${names.join(' · ')}${currentRoster.length > 3 ? ` +${currentRoster.length - 3}` : ''}`;
  }

  function statusMarkup(round, currentRoster) {
    const parts = [
      `<span class="pill primary"><b>${round <= 16 ? `Round ${round}` : 'Complete'}</b></span>`
    ];
    if (round <= 16) {
      parts.push(`<span class="pill">Your pick <b>${pickLabel(round)} · #${Engine.PICKS[round - 1]}</b></span>`);
    }
    parts.push('<span class="pill">Opponent tracking <b>not required</b></span>');
    parts.push(`<span class="pill">Build <b>${escapeHtml(Engine.construction(currentRoster))}</b></span>`);
    return parts.join('');
  }

  function teamMarkup(currentRoster) {
    const counts = Engine.counts(currentRoster);
    const countMarkup = Object.keys(counts)
      .map(pos => `<span><b>${counts[pos]}</b> ${pos}</span>`)
      .join('');
    const list = currentRoster.length
      ? currentRoster.map((player, index) => `R${index + 1}: <b>${escapeHtml(player.name)}</b> <small>${player.pos} · ADP ${Number(player.adp).toFixed(1)}</small>`).join('<br>')
      : 'Your selections will appear here.';
    return `<div class="counts">${countMarkup}</div><div class="roster">${list}</div>`;
  }

  function nodeMarkup(player, index, fullRoster) {
    const round = index + 1;
    const nextPlan = Engine.plan(round + 1, fullRoster.slice(0, index + 1));
    return `
      <section class="node" aria-label="Round ${round}: ${escapeHtml(player.name)}">
        <div class="node-row">
          <div class="round"><b>R${round}</b><small>${pickLabel(round)} · #${Engine.PICKS[index]}</small></div>
          <div class="player">
            <b>${escapeHtml(player.name)} · ${player.pos}</b>
            <small>${escapeHtml(player.team || '')}${player.bye ? ` · Bye ${player.bye}` : ''} · ADP ${Number(player.adp).toFixed(1)}</small>
          </div>
          <button class="change" data-edit="${index}" aria-label="Change Round ${round} selection">Change</button>
        </div>
        <div class="effect">Next plan: ${escapeHtml(nextPlan)}</div>
      </section>`;
  }

  function valueLabel(player) {
    const ensemble = Number(player.ensembleRank);
    const projection = Number(player.projectionEnsemble ?? player.projection);
    const vor = Number(player.vor);
    if (Number.isFinite(ensemble)) {
      return `Model rank ${ensemble.toFixed(1)}${Number.isFinite(projection) ? ` · ${projection.toFixed(0)} projected pts` : ''}`;
    }
    if (Number.isFinite(vor)) return `14-team VOR ${vor >= 0 ? '+' : ''}${vor.toFixed(1)}`;
    return 'Multi-source value estimate';
  }

  function availabilityMarkup(availability) {
    const probability = Math.round(availability.probability * 100);
    return `
      <span class="availability ${availability.key}">
        <b>${escapeHtml(availability.text)}</b>
        <small>${probability}% modeled chance · usual range ${availability.range.early}–${availability.range.late}</small>
      </span>`;
  }

  function optimizationMetrics(entry, index, round) {
    const details = entry.details || {};
    const metrics = [];
    if (details.optimized) {
      metrics.push(`${details.rollouts} board simulations`);
      metrics.push(`${details.horizon}-turn lookahead`);
      if (index === 0 && details.confidence) metrics.push(details.confidence);
      else if (Number.isFinite(details.behindTop)) metrics.push(`${details.behindTop.toFixed(1)} model pts behind #1`);
      if (details.commonNextPositions && round < 16) metrics.push(`Next path: ${details.commonNextPositions}`);
    }
    return metrics;
  }

  function recommendationCard(entry, index, round, currentRoster) {
    const player = entry.player;
    const details = entry.details || {};
    const labels = Engine.reasons(entry, currentRoster, round, index);
    const nextPlan = round === 16 ? 'Draft complete' : Engine.plan(round + 1, [...currentRoster, player]);
    const status = player.status
      ? `<div class="player-alert ${player.excluded ? 'danger' : ''}"><b>${escapeHtml(player.status)}</b>${player.statusNote ? ` · ${escapeHtml(player.statusNote)}` : ''}</div>`
      : '';
    const metrics = [valueLabel(player), ...optimizationMetrics(entry, index, round)];

    return `
      <article class="card ${index === 0 ? 'best' : ''}" data-recommendation-card>
        <div class="card-content">
          <div class="card-top">
            <div class="pos">${player.pos}</div>
            <div class="card-name">
              <b>${escapeHtml(player.name)}</b>
              <small>${escapeHtml(player.team || '')}${player.bye ? ` · Bye ${player.bye}` : ''} · ADP ${Number(player.adp).toFixed(1)}</small>
            </div>
            <span class="rank">${index === 0 ? 'MODEL PICK' : `OPTION ${index + 1}`}</span>
          </div>
          <div class="availability-row">${availabilityMarkup(entry.availability)}</div>
          <div class="metrics">${metrics.map(metric => `<span>${escapeHtml(metric)}</span>`).join('')}</div>
          <div class="why">${labels.map(label => `<span>${escapeHtml(label)}</span>`).join('')}</div>
          ${status}
          <div class="next">If drafted: ${escapeHtml(nextPlan)}</div>
        </div>
        <button class="draft-action" data-pick="${escapeHtml(player.key)}">Draft ${escapeHtml(player.name)}</button>
      </article>`;
  }

  function fallerButton(entry) {
    const player = entry.player;
    const probability = Math.round(entry.availability.probability * 100);
    return `
      <button class="faller" data-pick="${escapeHtml(player.key)}">
        <span class="faller-pos">${player.pos}</span>
        <span class="faller-name"><b>${escapeHtml(player.name)}</b><small>${probability}% chance at this pick</small></span>
        <strong>Draft if there</strong>
      </button>`;
  }

  function splitBoard(entries, round) {
    if (round >= 15) return { fallers: [], expected: entries };
    const pick = Engine.PICKS[round - 1];
    const fallers = entries.filter(entry => {
      const modelRank = Number(entry.player.ensembleRank ?? entry.player.valueRank ?? entry.player.adp);
      return entry.availability.probability < 0.48 && modelRank <= pick - 2;
    }).slice(0, 4);
    const fallerKeys = new Set(fallers.map(entry => entry.player.key));
    let expected = entries.filter(entry => !fallerKeys.has(entry.player.key) && entry.availability.probability >= 0.22);
    if (expected.length < 6) {
      const used = new Set([...fallerKeys, ...expected.map(entry => entry.player.key)]);
      expected = [...expected, ...entries.filter(entry => !used.has(entry.player.key))];
    }
    return { fallers, expected };
  }

  function branchMarkup(round, currentRoster) {
    const all = rankings(round, currentRoster);
    const { fallers, expected } = splitBoard(all, round);
    const baseCount = round === 1 ? 7 : 6;
    const shown = expected.slice(0, baseCount + Number(state.more || 0));

    if (!shown.length && !fallers.length) {
      return `
        <section class="branch" id="branch">
          <div class="branch-title">
            <small>ROUND ${round} · ${pickLabel(round)} · OVERALL ${Engine.PICKS[round - 1]}</small>
            <h2>No recommendations remain</h2>
            <p>Undo or change an earlier selection to rebuild this branch.</p>
          </div>
        </section>`;
    }

    const top = shown[0]?.details || fallers[0]?.details || {};
    const modelDescription = top.optimized
      ? `${top.rollouts} board simulations per candidate with ${top.horizon} future snake turns evaluated.`
      : 'Ranked by projected value, roster fit, and expected availability.';

    return `
      <section class="branch" id="branch" aria-labelledby="round-heading">
        <div class="branch-title">
          <small>YOU ARE ON THE CLOCK · ROUND ${round} · ${pickLabel(round)} · #${Engine.PICKS[round - 1]}</small>
          <h2 id="round-heading">Tap the best player who is actually available</h2>
          <p>${escapeHtml(modelDescription)} You do not need to enter the other 13 teams’ selections.</p>
        </div>
        ${fallers.length ? `
          <section class="faller-zone" aria-labelledby="faller-heading">
            <div class="section-heading">
              <div><span class="eyebrow">CHECK FIRST</span><h3 id="faller-heading">Premium fallers</h3></div>
              <p>Only tap one of these when the player is still available in your real draft.</p>
            </div>
            <div class="faller-list">${fallers.map(fallerButton).join('')}</div>
          </section>` : ''}
        <section class="expected-zone" aria-labelledby="expected-heading">
          <div class="section-heading">
            <div><span class="eyebrow">MOST USEFUL ON DRAFT NIGHT</span><h3 id="expected-heading">Expected choices at your pick</h3></div>
            <p>Ordered by projected team outcome, then adjusted for the chance each player reaches you.</p>
          </div>
          <div class="cards">${shown.map((entry, index) => recommendationCard(entry, index, round, currentRoster)).join('')}</div>
        </section>
        <div class="tools">
          ${shown.length < expected.length ? '<button class="tool" id="more">Show 4 more possibilities</button>' : ''}
        </div>
      </section>`;
  }

  function render({ scroll = false } = {}) {
    const currentRoster = roster();
    const round = currentRound();
    let html = '<div class="root">Your draft path<small>Tap only your own selection. Each pick rebuilds the recommendations below it.</small></div>';

    currentRoster.forEach((player, index) => {
      html += nodeMarkup(player, index, currentRoster);
    });

    html += round <= 16
      ? branchMarkup(round, currentRoster)
      : '<section class="done"><h2>Draft complete</h2><p>Your 16-round roster is saved on this device.</p></section>';

    treeEl.innerHTML = html;
    statusEl.innerHTML = statusMarkup(round, currentRoster);
    constructionEl.textContent = compactTeamLabel(currentRoster);
    teamEl.innerHTML = teamMarkup(currentRoster);
    sourceEl.textContent = sourceText();
    undoEl.disabled = history.length === 0;
    document.body.classList.toggle('draft-started', currentRoster.length > 0);
    bind();
    if (scroll) scrollToBranch();
  }

  function selectPlayer(playerKey) {
    const round = currentRound();
    const current = rankings(round);
    const index = current.findIndex(entry => entry.player.key === playerKey);
    if (index < 0) return;
    const player = byKey.get(playerKey);

    runBusy(() => {
      snapshot();
      state.retired[round - 1] = current.slice(0, index).map(entry => entry.player.key);
      state.selected.push(playerKey);
      state.more = 0;
      save();
      render({ scroll: true });
      announce(`${player.name} drafted. Round ${round + 1} recommendations are ready.`);
    }, `Drafting ${player.name} and recalculating the tree`);
  }

  function bind() {
    document.querySelectorAll('[data-pick]').forEach(button => {
      button.addEventListener('click', () => selectPlayer(button.dataset.pick));
    });

    document.querySelectorAll('[data-edit]').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.edit);
        runBusy(() => {
          snapshot();
          state.selected = state.selected.slice(0, index);
          state.retired = state.retired.slice(0, index);
          state.more = 0;
          save();
          render({ scroll: true });
          announce(`Round ${index + 1} reopened.`);
        }, `Reopening Round ${index + 1}`);
      });
    });

    $('#more')?.addEventListener('click', () => {
      snapshot();
      state.more += 4;
      save();
      render();
      announce('Four more draft possibilities shown.');
    });
  }

  undoEl.addEventListener('click', () => {
    if (!history.length) return;
    runBusy(() => {
      state = JSON.parse(history.pop());
      save();
      render();
      announce('Last action undone.');
    }, 'Undoing the last action');
  });

  resetEl.addEventListener('click', () => {
    if (!window.confirm('Reset the full draft tree?')) return;
    runBusy(() => {
      snapshot();
      state = { selected: [], retired: [], more: 0 };
      save();
      render({ scroll: true });
      announce('Draft tree reset to Round 1.');
    }, 'Resetting the draft tree');
  });

  if (!pool.length || !Engine || !Availability) {
    treeEl.innerHTML = '<section class="done"><h2>Data failed to load</h2><p>Refresh the page. If this continues, the current deployment is incomplete.</p></section>';
    return;
  }

  render();
})();
