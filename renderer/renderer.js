const cardsEl = document.getElementById('cards');
const cardsByHost = new Map();

// ── Card widgets ──
// TWO widget families, not two skins. `card` is the rack module (widgets/job-card.js) that skins
// repaint; `reactor` is the control-panel widget (widgets/reactor-panel.js), which has its own
// markup, its own instruments and its own honesty branches. A skin is CSS over one DOM and never
// rebuilds a card; changing FAMILY necessarily does, so the two are kept apart here rather than
// pretending the panel is another paint job.
const WIDGETS = {
  card: {
    create: (hostName, kind) => window.Widgets.createCard(hostName, kind),
    update: (el, hostName, snapshot) => window.Widgets.updateCard(el, hostName, snapshot),
    destroy: (el) => window.Widgets.destroyCard(el),
    refreshFace: (el) => window.Widgets.refreshCardFace(el),
  },
  reactor: {
    create: (hostName, kind, look) => window.Widgets.createReactorPanel(hostName, kind, look.idiom),
    update: (el, hostName, snapshot) => window.Widgets.updateReactorPanel(el, hostName, snapshot),
    destroy: (el) => window.Widgets.destroyReactorPanel(el),
    refreshFace: (el) => window.Widgets.refreshReactorFace(el),
  },
};

/** The widget that built a card, so removal and refresh call the right module. */
function widgetOf(el) {
  return WIDGETS[el.dataset.widget === 'reactor' ? 'reactor' : 'card'];
}

function dropCard(hostName, el) {
  widgetOf(el).destroy(el); // unregisters the card's needles from the shared rAF loop
  el.remove();
  cardsByHost.delete(hostName);
}

// The most recent payload, kept so a look change can repaint immediately instead of waiting for
// the next collector tick — half a second of stale rack while judging a look reads as a bug.
let lastSnapshots = {};

function render(snapshots) {
  lastSnapshots = snapshots;
  const seen = new Set(Object.keys(snapshots));
  // Relay verdicts are per host and only meaningful once jobs run, so the setup panel is fed from
  // the same stream the cards are.
  window.Widgets.updateSetupRelayStatus(snapshots);

  // Remove cards for hosts no longer present.
  for (const [hostName, card] of cardsByHost) {
    if (!seen.has(hostName)) dropCard(hostName, card);
  }

  const look = currentLook();
  for (const [hostName, snapshot] of Object.entries(snapshots)) {
    const kind = snapshot?.host?.kind ?? 'comfyui';
    let card = cardsByHost.get(hostName);
    // A card is built for its kind (meter face, identity labels) and for its widget family, so a
    // host switched from generation to training in settings — or a rack switched to the reactor
    // panel — gets a new card rather than a relabelled one. Everything else (skin, filter, size,
    // rack order) is applied without a rebuild, which is what keeps a running job's readout and its
    // needle intact.
    const stale = card && (card.dataset.kind !== kind
      || (card.dataset.widget ?? 'card') !== look.widget
      || (look.idiom != null && card.dataset.idiom !== look.idiom));
    if (stale) {
      dropCard(hostName, card);
      card = null;
    }
    if (!card) {
      card = WIDGETS[look.widget].create(hostName, kind, look);
      wireDrag(card);
      cardsByHost.set(hostName, card);
      cardsEl.appendChild(card);
    }
    // Rack position comes from the config file's order, not from whichever host answered first
    // (which is what the snapshot map's key order is). CSS `order` on a grid item does the whole
    // job — no DOM reshuffling, so a card is never rebuilt and never loses its needle mid-swing.
    setCardOrder(card, snapshot?.host?.order);
    widgetOf(card).update(card, hostName, snapshot);
  }
}

function setCardOrder(card, order) {
  card.style.order = Number.isFinite(order) ? String(order) : '';
}

window.comfyuiWatcher.onData(render);

// ── Rack order: drag a module to a new slot ──
// The rack is a rack: modules get moved by hand. Dragging a card rewrites the host order in
// hosts.json (the settings panel's arrows do the same thing for anyone who would rather not drag),
// and the new order is applied to the cards on screen immediately rather than waiting for the next
// snapshot tick. Nothing inside a card is interactive, so the whole faceplate is the grab handle.
const DROP_CLASSES = ['job-card--drop-before', 'job-card--drop-after'];
let dragHost = null;

function clearDropMarks() {
  for (const card of cardsByHost.values()) card.classList.remove(...DROP_CLASSES);
}

function wireDrag(card) {
  card.draggable = true;

  card.addEventListener('dragstart', (event) => {
    dragHost = card.dataset.host;
    card.classList.add('job-card--dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Chromium refuses to start a drag with an empty payload, even when the data is unused.
    event.dataTransfer.setData('text/plain', dragHost);
  });

  card.addEventListener('dragend', () => {
    dragHost = null;
    card.classList.remove('job-card--dragging');
    clearDropMarks();
  });

  card.addEventListener('dragover', (event) => {
    if (!dragHost || dragHost === card.dataset.host) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // Which side of this module it lands on. Horizontal midpoint, because the rack flows in
    // columns first — on a one-column rack every card is full width and the halves still read as
    // "before this one" / "after this one".
    //
    // The `/ zoom` is not optional. The SIZE control puts `zoom` on the card, and in this Chromium
    // getBoundingClientRect on a zoomed element reports its OWN scaled coordinate space (a card in
    // a 736px track measures 898 at zoom 0.82) while a mouse event's clientX stays in viewport
    // pixels. Comparing them raw put the midpoint in the wrong place on every size except Normal —
    // dropping on the right half moved the module left.
    const zoom = parseFloat(getComputedStyle(card).zoom) || 1;
    const box = card.getBoundingClientRect();
    const after = event.clientX / zoom - box.left > box.width / 2;
    clearDropMarks();
    card.classList.add(after ? 'job-card--drop-after' : 'job-card--drop-before');
  });

  card.addEventListener('drop', async (event) => {
    if (!dragHost || dragHost === card.dataset.host) return;
    event.preventDefault();
    const after = card.classList.contains('job-card--drop-after');
    const moved = dragHost;
    dragHost = null;
    clearDropMarks();
    await moveHost(moved, card.dataset.host, after);
  });
}

/** Move `fromName` to just before/after `toName` in the persisted host list. */
async function moveHost(fromName, toName, after) {
  const hosts = await window.comfyuiWatcher.getHosts();
  const from = hosts.findIndex((h) => h.name === fromName);
  if (from < 0 || !hosts.some((h) => h.name === toName)) return;
  const [entry] = hosts.splice(from, 1);
  // Re-find the target AFTER the removal, or a move from left to right lands one slot short.
  const to = hosts.findIndex((h) => h.name === toName);
  hosts.splice(to + (after ? 1 : 0), 0, entry);
  const saved = await window.comfyuiWatcher.setHosts(hosts);
  // Repaint the order now. Snapshots carry it too, but they arrive on the collector's own 500ms
  // tick and a rack that lags half a second behind the drop feels broken.
  let i = 0;
  for (const host of saved) {
    if (host.hidden) continue; // hidden hosts have no card and no rack slot
    const target = cardsByHost.get(host.name);
    if (target) setCardOrder(target, i);
    i++;
  }
}

// ── Look ──
// One control, two kinds of entry. The first three are SKINS in the guiTOP sense: a class on
// <body>, pure CSS over the rack card's one DOM (styles/skins.css), so switching never rebuilds a
// card or interrupts a running job's readout. The last two select the REACTOR PANEL widget in one
// of its two idioms — a different DOM, so those switches do rebuild the rack. They share the
// dropdown because from the desk they are one question ("what does the rack look like"), and they
// share one localStorage key for the same reason.
const LOOKS = [
  { id: 'rack', widget: 'card', body: 'skin-rack' },
  { id: 'glass', widget: 'card', body: 'skin-glass' },
  { id: 'halo', widget: 'card', body: 'skin-halo' },
  { id: 'room', widget: 'reactor', idiom: 'room', body: 'layout-reactor' },
  { id: 'console', widget: 'reactor', idiom: 'console', body: 'layout-reactor' },
];
const LOOK_KEY = 'comfyuiwatcher-skin';
const BODY_CLASSES = [...new Set(LOOKS.map((l) => l.body))];

function lookById(id) {
  return LOOKS.find((l) => l.id === id) ?? LOOKS[0];
}

function currentLook() {
  return lookById(lookSelect.value);
}

function applyLook(id) {
  const look = lookById(id);
  for (const cls of BODY_CLASSES) document.body.classList.toggle(cls, cls === look.body);
  // The reactor panel's two idioms share one body class, so the panel itself carries which one it
  // is (data-idiom) — that is also what render() compares against to decide a rebuild.
  document.body.dataset.idiom = look.idiom ?? '';
}

const lookSelect = document.getElementById('skin-select');
const savedLook = localStorage.getItem(LOOK_KEY);
const startLook = LOOKS.some((l) => l.id === savedLook) ? savedLook : 'rack';
lookSelect.value = startLook;
applyLook(startLook);
lookSelect.addEventListener('change', () => {
  applyLook(lookSelect.value);
  localStorage.setItem(LOOK_KEY, lookSelect.value);
  // Repaint from the last payload rather than waiting for the next collector tick: a look is judged
  // by flipping between them, and half a second of the old rack after the change reads as a bug.
  render(lastSnapshots);
});

// ── Dial ranges ──
// Set in the hosts panel (Dials). The faces are reprinted in place; a card is never rebuilt, so a
// running job keeps its numbers and its needle keeps whatever it was pointing at.
document.addEventListener('comfyuiwatcher:dial-range', () => {
  for (const card of cardsByHost.values()) widgetOf(card).refreshFace(card);
});

// ── Module size ──
// How wide a rack column is, i.e. how many modules fit across the window. A widget gets parked at
// whatever size fits the desk, and the window width alone decided both the column count AND the
// card layout, so most widths gave either two cramped stacked cards or one very wide one. This is
// the knob that separates those two decisions: pick the module size, and the rack fits as many as
// the window holds. Sizes are declared in styles/main.css as --card-min per body class.
const SIZES = ['compact', 'normal', 'large'];
const SIZE_KEY = 'comfyuiwatcher-card-size';

function applySize(size) {
  for (const s of SIZES) document.body.classList.toggle(`size-${s}`, s === size);
}

const sizeSelect = document.getElementById('size-select');
const savedSize = localStorage.getItem(SIZE_KEY);
const startSize = SIZES.includes(savedSize) ? savedSize : 'normal';
sizeSelect.value = startSize;
applySize(startSize);
sizeSelect.addEventListener('change', () => {
  applySize(sizeSelect.value);
  localStorage.setItem(SIZE_KEY, sizeSelect.value);
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
