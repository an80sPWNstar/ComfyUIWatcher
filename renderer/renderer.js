const cardsEl = document.getElementById('cards');
const cardsByHost = new Map();

function render(snapshots) {
  const seen = new Set(Object.keys(snapshots));

  // Remove cards for hosts no longer present.
  for (const [hostName, card] of cardsByHost) {
    if (!seen.has(hostName)) {
      window.Widgets.destroyCard(card); // unregisters the card's needle from the shared rAF loop
      card.remove();
      cardsByHost.delete(hostName);
    }
  }

  for (const [hostName, snapshot] of Object.entries(snapshots)) {
    let card = cardsByHost.get(hostName);
    if (!card) {
      card = window.Widgets.createCard(hostName);
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

// Settings panel sits above the cards; gear button in the top bar toggles it.
const appEl = document.getElementById('app');
appEl.insertBefore(window.Widgets.createSettingsPanel(), cardsEl);
document.getElementById('settings-btn').addEventListener('click', () => {
  window.Widgets.toggleSettingsPanel();
});
