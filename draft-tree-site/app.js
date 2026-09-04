(() => {
  'use strict';

  const Engine = window.DraftEngine;
  const pool = Array.isArray(window.players) ? window.players : [];
  const meta = window.draftMeta || {};
  const storageKey = 'pick9-audited-tree-v2';
  const byKey = new Map(pool.map(player => [player.key, player]));

  let state = { selected: [], gone: [], retired: [], more: 0 };
  let history = [];

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    state = { ...state, ...saved };
  } catch (_) {}

  state.selected = (state.selected || []).filter(key => byKey.has(key));
  state.gone = (state.gone || []).filter(key => byKey.has(key));
  state.retired = (state.retired || []).map(list => (list || []).filter(key => byKey.has(key)));

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

  function blockedKeys() {
    return new Set([
      ...state.selected,
      ...state.gone,
      ...(state.retired || []).flat()
    ]);
  }

  function rankings(round = currentRound(), currentRoster = roster()) {
    return Engine.rankPlayers(pool, blockedKeys(), currentRoster, round);
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
    return `${draftCount || 'Current'} exact-format mocks ${dateText} · 14-team half-PPR value model · recommendation audit v2`;
  }

  function statusMarkup(round, currentRoster) {
    const parts = [
      `<span class="pill"><b>${round <= 16 ? `Round ${round}` : 'Complete'}</b></span>`
    ];
    if (round <= 16) {
      parts.push(`<span class="pill">Pick <b>${pickLabel(round)} / #${Engine.PICKS[round - 1]}</b></span>`);
    }
    parts.push(`<span class="pill">Path <b>${escapeHtml(Engine.construction(currentRoster))}</b></span>`);
    return parts.join('');
  }

  function teamMarkup(currentRoster) {
    const c = Engine.counts(currentRoster);
    const counts = Object.keys(c)
      .map(pos => `<span><b>${c[pos]}</b> ${pos}</span>`)
      .join('');
    const list = currentRoster.length
      ? currentRoster.map((player, index) => `R${index + 1}: <b>${escapeHtml(player.name)}</b> (${player.pos})`).join('<br>')
      : 'No picks yet';
    return `<div class="counts">${counts}</div><div class="roster">${list}</div>`;
  }

  function nodeMarkup(player, index, fullRoster) {
    const round = index + 1;
    const nextPlan = Engine.plan(round + 1, fullRoster.slice(0, index + 1));
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
        <div class="effect">Next: ${escapeHtml(nextPlan)}</div>
      </section>`;
  }

  function valueLabel(player) {
    if (Number.isFinite(Number(player.valueRank))) {
      return `14T value #${player.valueRank} · VOR ${Number(player.vor) >= 0 ? '+' : ''}${Number(player.vor).toFixed(1)}`;
    }
    return `Estimated 14T value · VOR ${Number(player.vor) >= 0 ? '+' : ''}${Number(player.vor).toFixed(1)}`;
  }

  function cardMarkup(entry, index, round, currentRoster) {
    const player = entry.player;
    const labels = Engine.reasons(entry, currentRoster, round, index);
    const chance = Math.round(entry.details.goneChance * 100);
    const nextPlan = round === 16 ? 'Draft complete' : Engine.plan(round + 1, [...currentRoster, player]);
    const status = player.status
      ? `<div class="player-alert ${player.excluded ? 'danger' : ''}"><b>${escapeHtml(player.status)}</b>${player.statusNote ? ` · ${escapeHtml(player.statusNote)}` : ''}</div>`
      : '';

    return `
      <article class="card ${index === 0 ? 'best' : ''}">
        <button class="draft" data-pick="${escapeHtml(player.key)}" aria-label="Draft ${escapeHtml(player.name)}">
          <div class="card-top">
            <div class="pos">${player.pos}</div>
            <div class="card-name">
              <b>${escapeHtml(player.name)}</b>
              <small>${escapeHtml(player.team || '')}${player.bye ? ` · Bye ${player.bye}` : ''} · ADP ${Number(player.adp).toFixed(1)}</small>
            </div>
            <span class="rank">${index === 0 ? 'BEST FIT' : `OPTION ${index + 1}`}</span>
          </div>
          <div class="metrics">
            <span>${escapeHtml(valueLabel(player))}</span>
            ${round < 16 ? `<span>${chance}% chance gone by next turn</span>` : ''}
          </div>
          <div class="why">${labels.map(label => `<span>${escapeHtml(label)}</span>`).join('')}</div>
          ${status}
          <div class="next">If selected → ${escapeHtml(nextPlan)}</div>
        </button>
        <div class="card-foot">
          <span>Tap card to draft</span>
          <button class="gone" data-gone="${escapeHtml(player.key)}" aria-label="Mark ${escapeHtml(player.name)} gone">Gone</button>
        </div>
      </article>`;
  }

  function branchMarkup(round, currentRoster) {
    const all = rankings(round, currentRoster);
    const baseCount = round === 1 ? 12 : 8;
    const shown = all.slice(0, baseCount + Number(state.more || 0));

    if (!shown.length) {
      return `
        <section class="branch" id="branch">
          <div class="branch-title">
            <small>ROUND ${round} · ${pickLabel(round)} · OVERALL ${Engine.PICKS[round - 1]}</small>
            <h2>No available leaves remain</h2>
            <p>Restore a player marked Gone or undo the previous action.</p>
          </div>
          <div class="tools">${state.gone.length ? '<button class="tool" id="restore">Restore last Gone</button>' : ''}</div>
        </section>`;
    }

    return `
      <section class="branch" id="branch">
        <div class="branch-title">
          <small>ROUND ${round} · ${pickLabel(round)} · OVERALL ${Engine.PICKS[round - 1]}</small>
          <h2>${escapeHtml(Engine.plan(round, currentRoster))}</h2>
          <p>Ranked by exact-format value, current ADP, roster construction, tier scarcity, and likelihood of surviving your next snake turn.</p>
        </div>
        <div class="cards">${shown.map((entry, index) => cardMarkup(entry, index, round, currentRoster)).join('')}</div>
        <div class="tools">
          ${shown.length < all.length ? '<button class="tool" id="more">Show more choices</button>' : ''}
          ${state.gone.length ? '<button class="tool" id="restore">Restore last Gone</button>' : ''}
        </div>
      </section>`;
  }

  function render({ scroll = false } = {}) {
    const currentRoster = roster();
    const round = currentRound();
    let html = '<div class="root">Your draft path<small>Each selection changes every recommendation below it.</small></div>';

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

    document.querySelectorAll('[data-edit]').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.edit);
        snapshot();
        state.selected = state.selected.slice(0, index);
        state.retired = state.retired.slice(0, index);
        state.more = 0;
        save();
        render({ scroll: true });
      });
    });

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
    state = { selected: [], gone: [], retired: [], more: 0 };
    save();
    render({ scroll: true });
  });

  if (!pool.length || !Engine) {
    treeEl.innerHTML = '<section class="done"><h2>Data failed to load</h2><p>Refresh the page. If this continues, the current draft data deployment is incomplete.</p></section>';
    return;
  }

  render();
})();
