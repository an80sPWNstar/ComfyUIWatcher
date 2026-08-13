const cardsEl = document.getElementById('cards');
const cardsByHost = new Map();

function render(snapshots) {
  const seen = new Set(Object.keys(snapshots));
  // Relay verdicts are per host and only meaningful once jobs run, so the setup panel is fed from
  // the same stream the cards are.
  window.Widgets.updateSetupRelayStatus(snapshots);

  // Remove cards for hosts no longer present.
  for (const [hostName, card] of cardsByHost) {
    if (!seen.has(hostName)) {
      window.Widgets.destroyCard(card); // unregisters the card's needle from the shared rAF loop
      card.remove();
      cardsByHost.delete(hostName);
    }
  }

  for (const [hostName, snapshot] of Object.entries(snapshots)) {
    const kind = snapshot?.host?.kind ?? 'comfyui';
    let card = cardsByHost.get(hostName);
    // A card is built for its kind (meter face, identity labels), so a host switched from
    // generation to training in settings gets a new card rather than a relabelled one.
    if (card && card.dataset.kind !== kind) {
      window.Widgets.destroyCard(card);
      card.remove();
      cardsByHost.delete(hostName);
      card = null;
    }
    if (!card) {
      card = window.Widgets.createCard(hostName, kind);
      cardsByHost.set(hostName, card);
      cardsEl.appendChild(card);
    }
    window.Widgets.updateCard(card, hostName, snapshot);
  }
}

window.comfyuiWatcher.onData(render);

// ── Skin ──
// Same mechanism as guiTOP: a class on <body>, remembered in localStorage. Skins are pure CSS
// here (styles/skins.css) — one DOM, one behaviour set — so switching never rebuilds a card or
// interrupts a running job's readout.
const SKINS = ['rack', 'glass'];
const SKIN_KEY = 'comfyuiwatcher-skin';

function applySkin(skin) {
  for (const s of SKINS) document.body.classList.toggle(`skin-${s}`, s === skin);
}

const skinSelect = document.getElementById('skin-select');
const savedSkin = localStorage.getItem(SKIN_KEY);
const startSkin = SKINS.includes(savedSkin) ? savedSkin : 'rack';
skinSelect.value = startSkin;
applySkin(startSkin);
skinSelect.addEventListener('change', () => {
  applySkin(skinSelect.value);
  localStorage.setItem(SKIN_KEY, skinSelect.value);
});

// ── Kind filter ──
// One rack, filtered — not tabs. A watcher's normal question is "what is this machine doing",
// and generation and training hosts answer it the same way; splitting them into tabs would hide
// half the rack behind a click for no gain. Pure CSS on a container class, so filtering never
// rebuilds a card or interrupts a running job's readout, same as skins.
const FILTERS = ['all', 'comfyui', 'aitoolkit'];
const FILTER_KEY = 'comfyuiwatcher-kind-filter';

function applyFilter(filter) {
  for (const f of FILTERS) cardsEl.classList.toggle(`filter-${f}`, f === filter);
}

const kindSelect = document.getElementById('kind-select');
const savedFilter = localStorage.getItem(FILTER_KEY);
const startFilter = FILTERS.includes(savedFilter) ? savedFilter : 'all';
kindSelect.value = startFilter;
applyFilter(startFilter);
kindSelect.addEventListener('change', () => {
  applyFilter(kindSelect.value);
  localStorage.setItem(FILTER_KEY, kindSelect.value);
});

// Settings panel sits above the cards; gear button in the top bar toggles it.
const appEl = document.getElementById('app');
appEl.insertBefore(window.Widgets.createSettingsPanel(), cardsEl);
document.getElementById('settings-btn').addEventListener('click', () => {
  window.Widgets.toggleSettingsPanel();
});

// Setup panel. Shown unprompted on first launch: without the relay node, ComfyUI cards can never
// show step progress, and a widget that silently does half its job looks broken rather than
// unconfigured. After that it lives behind the (i) button.
appEl.insertBefore(window.Widgets.createSetupPanel(), cardsEl);
document.getElementById('setup-btn').addEventListener('click', () => {
  window.Widgets.toggleSetupPanel();
});
window.Widgets.maybeShowSetupPanel();
