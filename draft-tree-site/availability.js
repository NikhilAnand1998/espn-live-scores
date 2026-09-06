(() => {
  'use strict';

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const value = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * value);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-value * value);
    return sign * y;
  }

  function normalCdf(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
  }

  function expectedSlot(player) {
    const adp = finite(player.adp) ?? 250;
    const ensemble = finite(player.ensembleRank);
    if (ensemble === null || ensemble <= 0) return adp;
    return adp * 0.76 + ensemble * 0.24;
  }

  function probabilityAtPick(player, overallPick) {
    const expected = expectedSlot(player);
    const spread = Math.max(1.8, finite(player.sd) ?? 8);
    const probability = 1 - normalCdf((overallPick - 0.5 - expected) / spread);
    return clamp(probability, 0.01, 0.99);
  }

  function label(probability) {
    if (probability >= 0.78) return { key: 'likely', text: 'Likely there' };
    if (probability >= 0.48) return { key: 'range', text: 'In range' };
    if (probability >= 0.22) return { key: 'possible', text: 'Possible faller' };
    return { key: 'longshot', text: 'Long-shot faller' };
  }

  function draftRange(player) {
    const expected = expectedSlot(player);
    const spread = Math.max(1.8, finite(player.sd) ?? 8);
    return {
      early: Math.max(1, Math.round(expected - spread * 0.68)),
      late: Math.max(1, Math.round(expected + spread * 0.68))
    };
  }

  function annotate(entry, overallPick) {
    const probability = probabilityAtPick(entry.player, overallPick);
    return {
      ...entry,
      availability: {
        probability,
        ...label(probability),
        range: draftRange(entry.player)
      }
    };
  }

  window.DraftAvailability = {
    expectedSlot,
    probabilityAtPick,
    label,
    draftRange,
    annotate,
    version: 'availability-band-v1'
  };
})();
