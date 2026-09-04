// Small production fixes layered after the main app bundle.
pickLabel = function (r) {
  return r + '.' + String(r % 2 ? 9 : 6).padStart(2, '0');
};
const originalPlan = plan;
plan = function (r, t) {
  const nextRound = r === undefined ? round() : r;
  if (nextRound > 16) return 'Draft complete';
  return originalPlan(nextRound, t === undefined ? team() : t);
};
render(false);
