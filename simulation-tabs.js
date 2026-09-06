(() => {
  'use strict';
  const app = document.querySelector('.app');
  const buttons = [...document.querySelectorAll('[data-app-tab]')];
  const panels = [...document.querySelectorAll('[data-app-panel]')];

  function show(name, focus = false) {
    const simulations = name === 'simulations';
    panels.forEach(panel => { panel.hidden = panel.dataset.appPanel !== name; });
    buttons.forEach(button => {
      const selected = button.dataset.appTab === name;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    app?.classList.toggle('simulations-active', simulations);
    document.title = simulations ? 'Best Simulated Drafts · Pick 9' : 'Pick 9 Draft Tree';
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  buttons.forEach((button, index) => {
    button.addEventListener('click', () => show(button.dataset.appTab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(index + step + buttons.length) % buttons.length];
      show(next.dataset.appTab, true);
    });
  });

  window.SimulationTabs = { show };
  show('live');
})();
