// Host add/remove panel. Plain DOM, no framework — same pattern as job-card.js.
// Reads/writes the host list through window.comfyuiWatcher.{getHosts,setHosts} (IPC to main,
// which persists to userData/hosts.json and restarts collectors via WatcherService.setHosts).
//
// Exposed API (attached to window.Widgets at the bottom of this file):
//   Widgets.createSettingsPanel() -> HTMLElement  (call once; caller appends to DOM)
//   Widgets.toggleSettingsPanel() -> void         (show/hide; refreshes host list on show)

(() => {
  let panelEl = null;

  /**
   * Build one row for the hosts list: "<name>  <url>  [Remove]".
   * Remove calls setHosts with the host filtered out, then re-renders the list
   * from the returned (validated) list.
   * @param {{name: string, url: string}} host
   * @param {HTMLElement} listEl the container to re-render after a change
   */
  function hostRow(host, listEl) {
    const row = document.createElement('div');
    row.className = 'settings-host-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'settings-host-name';
    nameSpan.textContent = host.name;

    const urlSpan = document.createElement('span');
    urlSpan.className = 'settings-host-url';
    urlSpan.textContent = host.url;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'settings-remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const hosts = await window.comfyuiWatcher.getHosts();
      const next = hosts.filter((h) => !(h.name === host.name && h.url === host.url));
      const saved = await window.comfyuiWatcher.setHosts(next);
      renderHostList(listEl, saved);
    });

    row.appendChild(nameSpan);
    row.appendChild(urlSpan);
    row.appendChild(removeBtn);

    return row;
  }

  /**
   * Clear listEl and append one hostRow per host.
   * @param {HTMLElement} listEl
   * @param {{name: string, url: string}[]} hosts
   */
  function renderHostList(listEl, hosts) {
    listEl.replaceChildren();
    for (const host of hosts) {
      listEl.appendChild(hostRow(host, listEl));
    }
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
      const newHost = { name, url };
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
    form.appendChild(urlInput);
    form.appendChild(addBtn);
    form.appendChild(errorDiv);

    return form;
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

    const formEl = addHostForm(listEl);

    panel.appendChild(title);
    panel.appendChild(listEl);
    panel.appendChild(formEl);

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
