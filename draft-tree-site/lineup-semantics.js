(() => {
  'use strict';

  const STORAGE_KEY = 'pick9-adversarial-ux-v2';
  const players = Array.isArray(window.players) ? window.players : [];
  const byKey = new Map(players.map(player => [player.key, player]));
  const TARGETS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1 };
  const skillPositions = new Set(['RB', 'WR', 'TE']);

  const chips = document.querySelector('#roster-chips');
  const teamBody = document.querySelector('#team-body');
  const board = document.querySelector('#board-shell');

  function selectedRoster() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return (saved.selected || []).map(key => byKey.get(key)).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function positionCounts(roster) {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
    for (const player of roster) {
      if (Object.prototype.hasOwnProperty.call(counts, player.pos)) counts[player.pos] += 1;
    }
    return counts;
  }

  function allocateLineup(roster) {
    const counts = positionCounts(roster);
    const filled = {
      QB: Math.min(counts.QB, TARGETS.QB),
      RB: Math.min(counts.RB, TARGETS.RB),
      WR: Math.min(counts.WR, TARGETS.WR),
      TE: Math.min(counts.TE, TARGETS.TE),
      FLEX: 0,
      DEF: Math.min(counts.DEF, TARGETS.DEF),
      K: Math.min(counts.K, TARGETS.K)
    };

    const flexEligible = Math.max(0, counts.RB - filled.RB)
      + Math.max(0, counts.WR - filled.WR)
      + Math.max(0, counts.TE - filled.TE);
    filled.FLEX = Math.min(TARGETS.FLEX, flexEligible);

    const starterCount = Object.values(filled).reduce((sum, value) => sum + value, 0);
    return {
      counts,
      filled,
      bench: Math.max(0, roster.length - starterCount)
    };
  }

  function chipMarkup(roster) {
    const allocation = allocateLineup(roster);
    const slots = ['QB', 'RB', 'WR', 'TE', 'FLEX'];
    const slotMarkup = slots.map(position => {
      const value = allocation.filled[position];
      const target = TARGETS[position];
      const stateClass = value >= target ? 'filled' : value > 0 ? 'partial' : '';
      return `<span class="roster-chip ${stateClass}" data-slot="${position}" aria-label="${position} starter slots filled ${value} of ${target}"><b>${value}/${target}</b> ${position}</span>`;
    }).join('');
    const benchClass = allocation.bench > 0 ? 'bench' : '';
    return `${slotMarkup}<span class="roster-chip ${benchClass}" data-slot="BN" aria-label="Bench players ${allocation.bench}"><b>${allocation.bench}</b> BN</span>`;
  }

  function renderChips() {
    if (!chips) return;
    const markup = chipMarkup(selectedRoster());
    if (chips.innerHTML !== markup) chips.innerHTML = markup;
  }

  function renderLineupSummary() {
    if (!teamBody) return;
    const existing = teamBody.querySelector('.lineup-format-summary');
    const allocation = allocateLineup(selectedRoster());
    const status = `QB ${allocation.filled.QB}/1 · RB ${allocation.filled.RB}/2 · WR ${allocation.filled.WR}/2 · TE ${allocation.filled.TE}/1 · FLEX ${allocation.filled.FLEX}/1 · BN ${allocation.bench}`;
    const markup = `
      <div class="lineup-format-summary">
        <b>Starting lineup: 1 QB · 2 RB · 2 WR · 1 TE · 1 FLEX · DEF · K</b>
        <span>${status}</span>
        <small>RB and WR totals are not extra starting slots. Any player beyond the required starters fills FLEX first, then the bench.</small>
      </div>`;
    if (existing) {
      if (existing.outerHTML.trim() !== markup.trim()) existing.outerHTML = markup;
    } else {
      teamBody.insertAdjacentHTML('afterbegin', markup);
    }
  }

  function candidateRole(player, roster) {
    const before = allocateLineup(roster);
    const after = allocateLineup([...roster, player]);

    if (Object.prototype.hasOwnProperty.call(TARGETS, player.pos)
      && player.pos !== 'FLEX'
      && after.filled[player.pos] > before.filled[player.pos]) {
      return `Fills ${player.pos} starter ${after.filled[player.pos]}/${TARGETS[player.pos]}`;
    }
    if (skillPositions.has(player.pos) && after.filled.FLEX > before.filled.FLEX) {
      return 'Fills FLEX starter 1/1';
    }
    return 'Bench/depth value';
  }

  function annotateRecommendationRoles() {
    if (!board) return;
    const roster = selectedRoster();
    for (const card of board.querySelectorAll('[data-recommendation-card]')) {
      const playerName = card.getAttribute('data-player-name');
      const player = players.find(candidate => candidate.name === playerName);
      const reasonList = card.querySelector('.reason-list');
      if (!player || !reasonList) continue;
      const label = candidateRole(player, roster);
      let role = reasonList.querySelector('.lineup-role');
      if (!role) {
        role = document.createElement('span');
        role.className = 'lineup-role';
        reasonList.prepend(role);
      }
      role.textContent = label;
    }
  }

  function refresh() {
    renderChips();
    renderLineupSummary();
    annotateRecommendationRoles();
  }

  const observer = new MutationObserver(() => queueMicrotask(refresh));
  if (chips) observer.observe(chips, { childList: true, subtree: true });
  if (teamBody) observer.observe(teamBody, { childList: true, subtree: true });
  if (board) observer.observe(board, { childList: true, subtree: true });

  window.DraftLineup = {
    targets: TARGETS,
    allocate: allocateLineup,
    roleFor: candidateRole,
    refresh
  };

  refresh();
})();
