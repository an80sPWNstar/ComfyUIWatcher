// Host add/remove panel. Plain DOM, no framework — same pattern as job-card.js.
// Reads/writes the host list through window.comfyuiWatcher.{getHosts,setHosts} (IPC to main,
// which persists to userData/hosts.json and restarts collectors via WatcherService.setHosts).
//
// Exposed API (attached to window.Widgets at the bottom of this file):
//   Widgets.createSettingsPanel() -> HTMLElement  (call once; caller appends to DOM)
//   Widgets.toggleSettingsPanel() -> void         (show/hide; refreshes host list on show)

(() => {
  let panelEl = null;

  /** Persist a whole host list and redraw the panel from the validated result. */
  async function saveHosts(next, listEl) {
    const saved = await window.comfyuiWatcher.setHosts(next);
    renderHostList(listEl, saved);
  }

  /**
   * Move one host up or down the list. THE LIST ORDER IS THE RACK ORDER — dragging a card does
   * exactly this, and these arrows are the same operation for anyone who would rather not drag
   * (and the only one that can move a hidden host, which has no card to grab).
   */
  async function moveHost(index, delta, listEl) {
    const hosts = await window.comfyuiWatcher.getHosts();
    const to = index + delta;
    if (to < 0 || to >= hosts.length) return;
    const [entry] = hosts.splice(index, 1);
    hosts.splice(to, 0, entry);
    await saveHosts(hosts, listEl);
  }

  /**
   * Hide/show a host. Hiding keeps the entry and stops watching it — no card, no collector, no
   * reconnect loop against a machine that is switched off. Unhiding starts it again from scratch.
   */
  async function toggleHidden(host, listEl) {
    const hosts = await window.comfyuiWatcher.getHosts();
    const next = hosts.map((h) => (h.name === host.name && h.url === host.url
      ? { ...h, hidden: !h.hidden }
      : h));
    await saveHosts(next, listEl);
  }

  function iconButton(className, label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Build one row for the hosts list: "<name> <kind> <url> [↑][↓][Hide][Remove]".
   * Remove calls setHosts with the host filtered out, then re-renders the list
   * from the returned (validated) list.
   * @param {{name: string, url: string, kind?: string, hidden?: boolean}} host
   * @param {number} index position in the list, i.e. its slot in the rack
   * @param {number} total how many hosts there are, so the end arrows can be disabled
   * @param {HTMLElement} listEl the container to re-render after a change
   */
  function hostRow(host, index, total, listEl) {
    const row = document.createElement('div');
    row.className = 'settings-host-row';
    row.classList.toggle('settings-host-row--hidden', !!host.hidden);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'settings-host-name';
    nameSpan.textContent = host.name;

    const kindSpan = document.createElement('span');
    kindSpan.className = 'settings-host-kind';
    kindSpan.textContent = host.kind === 'aitoolkit' ? 'train' : 'gen';

    const urlSpan = document.createElement('span');
    urlSpan.className = 'settings-host-url';
    urlSpan.textContent = host.url;

    const upBtn = iconButton('settings-move-btn', '↑', 'Move up the rack',
      () => moveHost(index, -1, listEl));
    upBtn.disabled = index === 0;
    const downBtn = iconButton('settings-move-btn', '↓', 'Move down the rack',
      () => moveHost(index, 1, listEl));
    downBtn.disabled = index === total - 1;

    // Says what it will DO, not what the host is — "Hide" on a visible host, "Show" on a hidden
    // one. The row itself already reads as hidden (dimmed, HIDDEN tag), so the button does not
    // have to double as the status.
    const hideBtn = iconButton(
      'settings-hide-btn',
      host.hidden ? 'Show' : 'Hide',
      host.hidden ? 'Watch this host again' : 'Keep the entry but stop watching this host',
      () => toggleHidden(host, listEl),
    );

    const removeBtn = iconButton('settings-remove-btn', 'Remove', 'Delete this host entry', async () => {
      const hosts = await window.comfyuiWatcher.getHosts();
      await saveHosts(hosts.filter((h) => !(h.name === host.name && h.url === host.url)), listEl);
    });

    const tag = document.createElement('span');
    tag.className = 'settings-host-tag';
    tag.textContent = host.hidden ? 'hidden' : '';

    row.append(nameSpan, kindSpan, urlSpan, tag, upBtn, downBtn, hideBtn, removeBtn);

    return row;
  }

  /**
   * Clear listEl and append one hostRow per host, in list order — which IS the rack order.
   * @param {HTMLElement} listEl
   * @param {{name: string, url: string}[]} hosts
   */
  function renderHostList(listEl, hosts) {
    listEl.replaceChildren();
    hosts.forEach((host, i) => {
      listEl.appendChild(hostRow(host, i, hosts.length, listEl));
    });
  }

  /**
   * The add-host form: two text inputs (name, url) + Add button + inline error line.
   * On Add: trim both; url required — if name empty, leave it '' (main-process validate()
   * fills it from the URL host). Optimistically prepend "http://" when the url has no scheme.
   * Then: hosts = await getHosts(); saved = await setHosts([...hosts, {name, url}]);
   * if the new url did NOT survive validation (not found in saved), show "invalid URL" in the
   * error line and do not clear the inputs; else clear inputs+error and renderHostList.
   * @param {HTMLElement} listEl
   */
  function addHostForm(listEl) {
    const form = document.createElement('div');
    form.className = 'settings-add-form';

    const nameInput = document.createElement('input');
    nameInput.className = 'settings-input';
    nameInput.placeholder = 'Name (optional)';

    const urlInput = document.createElement('input');
    urlInput.className = 'settings-input';
    urlInput.placeholder = 'http://host:8188';

    // Which collector the host gets. The placeholder follows the choice because the two default
    // ports are the single most useful hint here (ComfyUI 8188, ai-toolkit's UI 8675).
    const kindSelect = document.createElement('select');
    kindSelect.className = 'settings-input settings-kind';
    for (const [value, label] of [['comfyui', 'Generation'], ['aitoolkit', 'Training']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      kindSelect.appendChild(opt);
    }
    kindSelect.addEventListener('change', () => {
      urlInput.placeholder = kindSelect.value === 'aitoolkit' ? 'http://host:8675' : 'http://host:8188';
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'settings-add-btn';
    addBtn.textContent = 'Add';

    const errorDiv = document.createElement('div');
    errorDiv.className = 'settings-error';

    const handleAdd = async () => {
      const name = nameInput.value.trim();
      let url = urlInput.value.trim();

      if (!url) {
        errorDiv.textContent = 'URL is required';
        return;
      }

      if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
      }

      const hosts = await window.comfyuiWatcher.getHosts();
      // An ai-toolkit UI started with AI_TOOLKIT_AUTH set also needs a `token` on the host entry.
      // That is rare enough to live in userData/hosts.json rather than take a field here.
      const newHost = { name, url, kind: kindSelect.value };
      const saved = await window.comfyuiWatcher.setHosts([...hosts, newHost]);

      // Compare against the normalized form main-process validate() stores (it strips
      // trailing slashes), or "http://host:8188/" would false-negative as invalid.
      const norm = url.replace(/\/+$/, '');
      const found = saved.some((h) => h.url === norm);
      if (!found) {
        errorDiv.textContent = 'invalid URL';
        return;
      }

      nameInput.value = '';
      urlInput.value = '';
      errorDiv.textContent = '';
      renderHostList(listEl, saved);
    };

    addBtn.addEventListener('click', handleAdd);
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      }
    });

    form.appendChild(nameInput);
    form.appendChild(kindSelect);
    form.appendChild(urlInput);
    form.appendChild(addBtn);
    form.appendChild(errorDiv);

    return form;
  }

  /**
   * Dial ranges. Both instruments are log scales, so their end stops decide how much of the arc a
   * real job actually uses: on the old fixed +/-100 it/s face everything Bryan generates sat within
   * a few degrees of centre. The wide face is still there for a fast run — it is a setting now, not
   * a guess baked into the widget.
   *
   * A change reprints the faces in place (Widgets.refreshCardFace via renderer.js) — no rebuild, so
   * a running job's readout and its needle are not interrupted.
   */
  function dialRow(kind, label, hint) {
    const row = document.createElement('div');
    row.className = 'settings-dial-row';

    const l = document.createElement('span');
    l.className = 'settings-dial-label';
    l.textContent = label;

    const select = document.createElement('select');
    select.className = 'settings-input settings-dial-select';
    for (const range of window.Widgets.dialRanges[kind]) {
      const opt = document.createElement('option');
      opt.value = String(range);
      // The face names its own ends — a sampling range is not symmetric any more.
      opt.textContent = window.Widgets.dialRangeLabel(kind, range);
      select.appendChild(opt);
    }
    select.value = String(window.Widgets.dialRange(kind));
    select.addEventListener('change', () => {
      window.Widgets.setDialRange(kind, Number(select.value));
      document.dispatchEvent(new CustomEvent('comfyuiwatcher:dial-range'));
    });

    const h = document.createElement('span');
    h.className = 'settings-dial-hint';
    h.textContent = hint;

    row.append(l, select, h);
    return row;
  }

  function dialSection() {
    const wrap = document.createElement('div');
    wrap.className = 'settings-dials';

    const title = document.createElement('div');
    title.className = 'settings-title settings-title--sub';
    title.textContent = 'Dials';

    wrap.append(
      title,
      dialRow('sampling', 'Images', 'end stops of the image sampling dial'),
      // A video job is detected from the running graph and printed on its own scale — a video
      // sampler and an image sampler are two orders of magnitude apart, so one face cannot read
      // both. This is the slow end of that face.
      dialRow('video', 'Video', 'slow end of the video dial'),
      dialRow('training', 'Training', 'slow end of the training dial'),
    );
    return wrap;
  }

  function createSettingsPanel() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.hidden = true;

    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Hosts';

    const listEl = document.createElement('div');
    listEl.className = 'settings-host-list';

    // Two things nobody would guess: that the cards themselves can be dragged, and that hiding is
    // not the same as the top-bar filter — it stops watching the host entirely.
    const note = document.createElement('div');
    note.className = 'settings-note';
    note.textContent = 'Order is the rack order — drag a card, or use the arrows. '
      + 'Hidden hosts keep their entry but are not watched.';

    const formEl = addHostForm(listEl);

    panel.appendChild(title);
    panel.appendChild(note);
    panel.appendChild(listEl);
    panel.appendChild(formEl);
    panel.appendChild(dialSection());

    panelEl = panel;
    return panel;
  }

  async function toggleSettingsPanel() {
    if (!panelEl) return;

    if (panelEl.hidden) {
      const hosts = await window.comfyuiWatcher.getHosts();
      const listEl = panelEl.querySelector('.settings-host-list');
      renderHostList(listEl, hosts);
      panelEl.hidden = false;
    } else {
      panelEl.hidden = true;
    }
  }

  window.Widgets = window.Widgets || {};
  window.Widgets.createSettingsPanel = createSettingsPanel;
  window.Widgets.toggleSettingsPanel = toggleSettingsPanel;
})();
