(() => {
  'use strict';
  if (!window.DraftEngine) return;
  const meta = window.draftMeta || {};
  window.DraftEngine.MODEL_VERSION = meta.modelVersion || window.DraftEngine.MODEL_VERSION || 'ensemble-rollout';
  window.DraftEngine.DATA_GENERATED_AT = meta.generatedAt || null;
  window.DraftEngine.MODEL_LABEL = 'Deterministic Monte Carlo lookahead';
})();
