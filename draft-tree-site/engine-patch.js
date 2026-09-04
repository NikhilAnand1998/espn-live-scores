(() => {
  const Engine = window.DraftEngine;
  const originalRankPlayers = Engine.rankPlayers;

  Engine.rankPlayers = function rankPlayersWithStableKeys(players, blockedValues, roster, round) {
    const blocked = blockedValues instanceof Set ? blockedValues : new Set(blockedValues || []);
    const expanded = new Set(blocked);
    for (const player of players) {
      if (blocked.has(player.key) || blocked.has(player.id)) {
        expanded.add(player.key);
        expanded.add(player.id);
      }
    }
    return originalRankPlayers(players, expanded, roster, round);
  };
})();
