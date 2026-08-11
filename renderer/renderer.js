const cardsEl = document.getElementById('cards');
const cardsByHost = new Map();

function render(snapshots) {
  const seen = new Set(Object.keys(snapshots));

  // Remove cards for hosts no longer present.
  for (const [hostName, card] of cardsByHost) {
    if (!seen.has(hostName)) {
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

// Settings panel sits above the cards; gear button in the top bar toggles it.
const appEl = document.getElementById('app');
appEl.insertBefore(window.Widgets.createSettingsPanel(), cardsEl);
document.getElementById('settings-btn').addEventListener('click', () => {
  window.Widgets.toggleSettingsPanel();
});
