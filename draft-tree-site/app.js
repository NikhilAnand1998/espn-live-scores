(() => {
  'use strict';

  const Engine = window.DraftEngine;
  const pool = Array.isArray(window.players) ? window.players : [];
  const meta = window.draftMeta || {};
  const storageKey = 'pick9-optimized-tree-v4';
  const byKey = new Map(pool.map(player => [player.key, player]));

  let state = {
    selected: [],
    gone: [],
    retired: [],
    autoBatches: [],
    autoMode: true,
    more: 0
  };
  let history = [];

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    state = { ...state, ...saved };
  } catch (_) {}

  state.selected = (state.selected || []).filter(key => byKey.has(key));
  state.gone = (state.gone || []).filter(key => byKey.has(key));
  state.retired = (state.retired || []).map(list =>
    (list || []).filter(key => byKey.has(key))
  );
  state.autoMode = state.autoMode !== false;
  state.autoBatches = (state.autoBatches || []).map((batch, index) => {
    if (!batch || typeof batch !== 'object') return null;
    const hidden = [...new Set((batch.hidden || []).filter(key => byKey.has(key)))];
    const reserve = [...new Set((batch.reserve || []).filter(key =>
      byKey.has(key) && !hidden.includes(key)
    ))];
    return {
      afterRound: Number(batch.afterRound || index + 1),
      count: Number(batch.count || hidden.length),
      rollouts: Number(batch.rollouts || 0),
      hidden,
      reserve,
      probabilities: batch.probabilities && typeof batch.probabilities === 'object'
        ? batch.probabilities
        : {},
      restored: [...new Set((batch.restored || []).filter(key => byKey.has(key)))]
    };
  });

  const $ = selector => document.querySelector(selector);
  const treeEl = $('#tree');
  const statusEl = $('#status');
  const constructionEl = $('#construction');
  const teamEl = $('#team');
  const undoEl = $('#undo');
  const resetEl = $('#reset');
  const sourceEl = $('#source-note');

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

  function autoHiddenKeys() {
    return (state.autoBatches || []).flatMap(batch => batch?.hidden || []);
  }

  function blockedKeys() {
    return new Set([
      ...state.selected,
      ...state.gone,
      ...(state.retired || []).flat(),
      ...autoHiddenKeys()
    ]);
  }

  function rankings(round = currentRound(), currentRoster = roster()) {
    return Engine.rankPlayers(pool, blockedKeys(), currentRoster, round);
  }

  function currentAutoBatch(round = currentRound()) {
    if (round <= 1) return null;
    const batch = state.autoBatches?.[round - 2] || null;
    return batch?.afterRound === round - 1 ? batch : null;
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

  function scrollToBranch() {
    const branch = $('#branch');
    if (!branch) return;
    branch.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => {
      const headerHeight = $('header')?.offsetHeight || 0;
      window.scrollBy({ top: -(headerHeight + 10), behavior: 'instant' });
    }, 180);
  }

  function sourceText() {
    const draftCount = Number(meta.draftCount || 0).toLocaleString();
    const dateText = meta.endDate ? `through ${meta.endDate}` : (meta.generatedAt || 'current');
    const external = [
      meta.rotowireMatches ? `${meta.rotowireMatches} RotoWire ranks` : '',
      meta.lineupBeatMatches ? `${meta.lineupBeatMatches} independent half-PPR projections` : '',
      meta.marketPropMatches ? `${meta.marketPropMatches} market-priced projections` : '',
      meta.giqProjectionMatches ? `${meta.giqProjectionMatches} GIQ projections` : ''
    ].filter(Boolean).join(' · ');
    const boardModel = Engine.AUTO_BOARD_VERSION
      ? ` · ${Engine.AUTO_BOARD_LABEL || 'Auto board'} ${Engine.AUTO_BOARD_VERSION}`
      : '';
    return `${draftCount || 'Current'} exact-format mocks ${dateText} · ${external || 'multi-source projections'} · ${Engine.MODEL_LABEL || 'lookahead optimizer'} ${Engine.MODEL_VERSION || ''}${boardModel}`;
  }

  function statusMarkup(round, currentRoster) {
    const parts = [
      `<span class="pill"><b>${round <= 16 ? `Round ${round}` : 'Complete'}</b></span>`
    ];
    if (round <= 16) {
      parts.push(`<span class="pill">Pick <b>${pickLabel(round)} / #${Engine.PICKS[round - 1]}</b></span>`);
    }
    parts.push(`<span class="pill">Board <b>${state.autoMode ? 'AUTO' : 'MANUAL'}</b></span>`);
    parts.push(`<span class="pill">Path <b>${escapeHtml(Engine.construction(currentRoster))}</b></span>`);
    return parts.join('');
  }

  function teamMarkup(currentRoster) {
    const counts = Engine.counts(currentRoster);
    const countMarkup = Object.keys(counts)
      .map(pos => `<span><b>${counts[pos]}</b> ${pos}</span>`)
      .join('');
    const list = currentRoster.length
      ? currentRoster.map((player, index) => `R${index + 1}: <b>${escapeHtml(player.name)}</b> (${player.pos})`).join('<br>')
      : 'No picks yet';
    return `<div class="counts">${countMarkup}</div><div class="roster">${list}</div>`;
  }

  function nodeMarkup(player, index, fullRoster) {
    const round = index + 1;
    const nextPlan = Engine.plan(round + 1, fullRoster.slice(0, index + 1));
    const autoBatch = state.autoBatches?.[index];
    const autoText = autoBatch?.hidden?.length
      ? ` · ${autoBatch.hidden.length} opponent picks auto-estimated`
      : '';
    return `
      <section class="node">
        <div class="node-row">
          <div class="round"><b>R${round}</b><small>${pickLabel(round)} · #${Engine.PICKS[index]}</small></div>
          <div class="player">
            <b>${escapeHtml(player.name)} · ${player.pos}</b>
            <small>${escapeHtml(player.team || '')}${player.bye ? ` · Bye ${player.bye}` : ''} · ADP ${Number(player.adp).toFixed(1)}</small>
          </div>
          <button class="change" data-edit="${index}" aria-label="Change Round ${round} selection">Change</button>
        </div>
        <div class="effect">Next: ${escapeHtml(nextPlan)}${escapeHtml(autoText)}</div>
      </section>`;
  }

  function valueLabel(player) {
    const ensemble = Number(player.ensembleRank);
    const projection = Number(player.projectionEnsemble ?? player.projection);
    const vor = Number(player.vor);
    if (Number.isFinite(ensemble)) {
      return `Ensemble #${ensemble.toFixed(1)} · ${Number.isFinite(projection) ? `${projection.toFixed(0)} pts` : 'projection estimated'}`;
    }
    if (Number.isFinite(vor)) return `14T VOR ${vor >= 0 ? '+' : ''}${vor.toFixed(1)}`;
    return 'Multi-source value estimate';
  }

  function optimizationMetrics(entry, index, round) {
    const details = entry.details || {};
    const metrics = [];
    if (details.optimized) {
      metrics.push(`${details.rollouts} board simulations · ${details.horizon}-turn lookahead`);
      if (index === 0) metrics.push(`${details.confidence || 'Model preferred'}${details.edge > 0 ? ` · edge +${details.edge.toFixed(1)}` : ''}`);
      else if (Number.isFinite(details.behindTop)) metrics.push(`${details.behindTop.toFixed(1)} model points behind #1`);
      if (details.commonNextPositions && round < 16) metrics.push(`Common continuation: ${details.commonNextPositions}`);
    }
    return metrics;
  }

  function cardMarkup(entry, index, round, currentRoster) {
    const player = entry.player;
    const details = entry.details || {};
    const labels = Engine.reasons(entry, currentRoster, round, index);
    const chance = Math.round((details.goneChance ?? 0) * 100);
    const nextPlan = round === 16 ? 'Draft complete' : Engine.plan(round + 1, [...currentRoster, player]);
    const status = player.status
      ? `<div class="player-alert ${player.excluded ? 'danger' : ''}"><b>${escapeHtml(player.status)}</b>${player.statusNote ? ` · ${escapeHtml(player.statusNote)}` : ''}</div>`
      : '';
    const metrics = [valueLabel(player), ...optimizationMetrics(entry, index, round)];
    if (round < 16) metrics.push(`${chance}% chance gone by next turn`);

    return `
      <article class="card ${index === 0 ? 'best' : ''} ${details.confidence === 'Close alternative' ? 'close' : ''}">
        <button class="draft" data-pick="${escapeHtml(player.key)}" aria-label="Draft ${escapeHtml(player.name)}">
          <div class="card-top">
            <div class="pos">${player.pos}</div>
            <div class="card-name">
              <b>${escapeHtml(player.name)}</b>
              <small>${escapeHtml(player.team || '')}${player.bye ? ` · Bye ${player.bye}` : ''} · ADP ${Number(player.adp).toFixed(1)}</small>
            </div>
            <span class="rank">${index === 0 ? 'MODEL PICK' : `OPTION ${index + 1}`}</span>
          </div>
          <div class="metrics">${metrics.map(metric => `<span>${escapeHtml(metric)}</span>`).join('')}</div>
          <div class="why">${labels.map(label => `<span>${escapeHtml(label)}</span>`).join('')}</div>
          ${status}
          <div class="next">If selected → ${escapeHtml(nextPlan)}</div>
        </button>
        <div class="card-foot">
          <span>Tap card to draft</span>
          <button class="gone" data-gone="${escapeHtml(player.key)}" aria-label="Mark ${escapeHtml(player.name)} taken">Taken</button>
        </div>
      </article>`;
  }

  function autoBoardMarkup(round) {
    const batch = currentAutoBatch(round);
    const nextPick = Engine.PICKS[round] || null;
    const upcomingGap = nextPick
      ? Math.max(0, nextPick - Engine.PICKS[round - 1] - 1)
      : 0;

    if (batch?.hidden?.length) {
      const players = batch.hidden
        .map(key => byKey.get(key))
        .filter(Boolean)
        .sort((first, second) => {
          const firstProbability = Number(batch.probabilities?.[first.key] || 0);
          const secondProbability = Number(batch.probabilities?.[second.key] || 0);
          return secondProbability - firstProbability || first.adp - second.adp;
        });
      return `
        <details class="auto-board">
          <summary>
            <span><b>Auto board estimated ${batch.hidden.length} opponent picks</b><small>Open only to restore an unexpected faller.</small></span>
            <strong>Review</strong>
          </summary>
          <div class="auto-body">
            <p>These players are temporarily treated as drafted between your turns. Tap <b>Still available</b> only when your draft room shows an exception. The model will substitute the next-most-likely selection automatically.</p>
            <div class="auto-list">
              ${players.map(player => {
                const probability = Math.round(Number(batch.probabilities?.[player.key] || 0) * 100);
                return `
                  <button class="auto-player" data-auto-restore="${escapeHtml(player.key)}">
                    <span><b>${escapeHtml(player.name)} · ${player.pos}</b><small>${probability ? `${probability}% estimated taken` : 'Estimated taken'}</small></span>
                    <strong>Still available</strong>
                  </button>`;
              }).join('')}
            </div>
            <button class="auto-toggle" id="toggle-auto">Switch to manual board updates</button>
          </div>
        </details>`;
    }

    if (state.autoMode && round < 16) {
      return `
        <div class="auto-ready">
          <span><b>Auto board is on</b><small>After this pick, it will estimate the ${upcomingGap} selections before ${pickLabel(round + 1)}.</small></span>
          <button id="toggle-auto">Turn off</button>
        </div>`;
    }

    if (!state.autoMode && round <= 16) {
      return `
        <div class="auto-ready manual">
          <span><b>Manual board mode</b><small>You will need to mark recommendations Taken yourself.</small></span>
          <button id="toggle-auto">Turn auto board on</button>
        </div>`;
    }

    return '';
  }

  function branchMarkup(round, currentRoster) {
    const all = rankings(round, currentRoster);
    const baseCount = round === 1 ? 16 : 8;
    const shown = all.slice(0, baseCount + Number(state.more || 0));

    if (!shown.length) {
      return `
        <section class="branch" id="branch">
          <div class="branch-title">
            <small>ROUND ${round} · ${pickLabel(round)} · OVERALL ${Engine.PICKS[round - 1]}</small>
            <h2>No available leaves remain</h2>
            <p>Restore a player marked Taken, review the estimated auto board, or undo the previous action.</p>
          </div>
          ${autoBoardMarkup(round)}
          <div class="tools">${state.gone.length ? '<button class="tool" id="restore">Restore last Taken</button>' : ''}</div>
        </section>`;
    }

    const top = shown[0]?.details || {};
    const modelDescription = top.optimized
      ? `${top.rollouts} deterministic board simulations per candidate with ${top.horizon} future snake turns evaluated.`
      : 'Late-round recommendation based on projected value, roster fit, and availability.';
    const boardDescription = currentAutoBatch(round)?.hidden?.length
      ? 'Opponent picks were estimated automatically; correct only unexpected fallers or a displayed player who is already taken.'
      : state.autoMode
        ? 'After you draft, the selections before your next turn will be estimated automatically.'
        : 'Manual board mode is active.';

    return `
      <section class="branch" id="branch">
        <div class="branch-title">
          <small>ROUND ${round} · ${pickLabel(round)} · OVERALL ${Engine.PICKS[round - 1]}</small>
          <h2>${escapeHtml(Engine.plan(round, currentRoster))}</h2>
          <p>${escapeHtml(modelDescription)} ${escapeHtml(boardDescription)}</p>
        </div>
        ${autoBoardMarkup(round)}
        <div class="cards">${shown.map((entry, index) => cardMarkup(entry, index, round, currentRoster)).join('')}</div>
        <div class="tools">
          ${shown.length < all.length ? '<button class="tool" id="more">Show more choices</button>' : ''}
          ${state.gone.length ? '<button class="tool" id="restore">Restore last Taken</button>' : ''}
        </div>
      </section>`;
  }

  function createAutoBatch(afterRound) {
    if (!state.autoMode || typeof Engine.predictOpponentPicks !== 'function' || afterRound >= 16) {
      return null;
    }

    const prediction = Engine.predictOpponentPicks(pool, blockedKeys(), afterRound, {
      extra: 14,
      rollouts: 180,
      seedKey: state.selected.join('>')
    });
    if (!prediction?.count || !prediction.selected?.length) return null;

    const probabilities = {};
    for (const entry of [...prediction.selected, ...prediction.reserve]) {
      probabilities[entry.player.key] = Number(entry.probability || 0);
    }

    return {
      afterRound,
      count: prediction.count,
      rollouts: prediction.rollouts,
      hidden: prediction.selected.map(entry => entry.player.key),
      reserve: prediction.reserve.map(entry => entry.player.key),
      probabilities,
      restored: []
    };
  }

  function setAutoBatchAfterPick(round) {
    state.autoBatches = state.autoBatches.slice(0, round - 1);
    state.autoBatches[round - 1] = createAutoBatch(round);
  }

  function restoreAutoPlayer(playerKey) {
    const round = currentRound();
    const batchIndex = round - 2;
    const batch = currentAutoBatch(round);
    if (!batch || !batch.hidden.includes(playerKey)) return;

    snapshot();
    batch.hidden = batch.hidden.filter(key => key !== playerKey);
    batch.reserve = batch.reserve.filter(key => key !== playerKey);
    batch.restored = [...new Set([...(batch.restored || []), playerKey])];

    const blockedOutsideBatch = new Set([
      ...state.selected,
      ...state.gone,
      ...(state.retired || []).flat()
    ]);
    state.autoBatches.forEach((otherBatch, index) => {
      if (index === batchIndex) return;
      for (const key of otherBatch?.hidden || []) blockedOutsideBatch.add(key);
    });

    const replacementIndex = batch.reserve.findIndex(key =>
      byKey.has(key)
      && key !== playerKey
      && !blockedOutsideBatch.has(key)
      && !batch.hidden.includes(key)
    );
    if (replacementIndex >= 0) {
      const [replacement] = batch.reserve.splice(replacementIndex, 1);
      batch.hidden.push(replacement);
    }

    state.more = 0;
    save();
    render();
  }

  function toggleAutoMode() {
    snapshot();
    const round = currentRound();
    state.autoMode = !state.autoMode;

    if (round > 1 && round <= 16) {
      const batchIndex = round - 2;
      state.autoBatches[batchIndex] = null;
      if (state.autoMode) {
        state.autoBatches[batchIndex] = createAutoBatch(round - 1);
      }
    }

    state.more = 0;
    save();
    render();
  }

  function render({ scroll = false } = {}) {
    const currentRoster = roster();
    const round = currentRound();
    let html = '<div class="root">Your optimized draft path<small>Your pick reruns the recommendation model and the auto board estimates every opponent selection before your next turn.</small></div>';

    currentRoster.forEach((player, index) => {
      html += nodeMarkup(player, index, currentRoster);
    });

    html += round <= 16
      ? branchMarkup(round, currentRoster)
      : '<section class="done"><h2>Draft complete</h2><p>Your 16-round roster is saved on this device.</p></section>';

    treeEl.innerHTML = html;
    statusEl.innerHTML = statusMarkup(round, currentRoster);
    constructionEl.textContent = Engine.construction(currentRoster);
    teamEl.innerHTML = teamMarkup(currentRoster);
    sourceEl.textContent = sourceText();
    undoEl.disabled = history.length === 0;
    bind();
    if (scroll) scrollToBranch();
  }

  function bind() {
    document.querySelectorAll('[data-pick]').forEach(button => {
      button.addEventListener('click', () => {
        const playerKey = button.dataset.pick;
        const round = currentRound();
        const current = rankings(round);
        const index = current.findIndex(entry => entry.player.key === playerKey);
        if (index < 0) return;

        snapshot();
        state.retired[round - 1] = current.slice(0, index).map(entry => entry.player.key);
        state.selected.push(playerKey);
        setAutoBatchAfterPick(round);
        state.more = 0;
        save();
        render({ scroll: true });
      });
    });

    document.querySelectorAll('[data-gone]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        snapshot();
        state.gone.push(button.dataset.gone);
        state.more = 0;
        save();
        render();
      });
    });

    document.querySelectorAll('[data-auto-restore]').forEach(button => {
      button.addEventListener('click', () => restoreAutoPlayer(button.dataset.autoRestore));
    });

    document.querySelectorAll('[data-edit]').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.edit);
        snapshot();
        state.selected = state.selected.slice(0, index);
        state.retired = state.retired.slice(0, index);
        state.autoBatches = state.autoBatches.slice(0, index);
        state.more = 0;
        save();
        render({ scroll: true });
      });
    });

    $('#toggle-auto')?.addEventListener('click', toggleAutoMode);

    $('#more')?.addEventListener('click', () => {
      snapshot();
      state.more += 8;
      save();
      render();
    });

    $('#restore')?.addEventListener('click', () => {
      snapshot();
      state.gone.pop();
      state.more = 0;
      save();
      render();
    });
  }

  undoEl.addEventListener('click', () => {
    if (!history.length) return;
    state = JSON.parse(history.pop());
    save();
    render();
  });

  resetEl.addEventListener('click', () => {
    if (!window.confirm('Reset the full draft tree?')) return;
    snapshot();
    state = {
      selected: [],
      gone: [],
      retired: [],
      autoBatches: [],
      autoMode: true,
      more: 0
    };
    save();
    render({ scroll: true });
  });

  if (!pool.length || !Engine) {
    treeEl.innerHTML = '<section class="done"><h2>Data failed to load</h2><p>Refresh the page. If this continues, the current draft data deployment is incomplete.</p></section>';
    return;
  }

  render();
})();
