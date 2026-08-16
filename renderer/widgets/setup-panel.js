// First-run setup panel: how to make ComfyUI step progress work.
//
// This exists because the app is USELESS-looking without a manual step, and a widget that shows
// an indeterminate sweep forever with no explanation reads as broken. ComfyUI sends execution
// messages only to the client that submitted the prompt, so a passive watcher cannot see step
// counts for jobs queued from the web UI. The relay custom node ships with the installer
// (extraResources -> resources/comfyui-relay) and rebroadcasts them; the user has to copy it in.
//
// Shown automatically on first launch, and reachable afterwards from the top bar. Once a host
// actually reports relay traffic the panel says so per host, so "did it work?" is answered by
// observation rather than by instructions.
//
// Exposed on window.Widgets:
//   createSetupPanel() -> HTMLElement   (call once; caller appends)
//   toggleSetupPanel() -> void
//   maybeShowSetupPanel() -> void       (first launch only)
//   updateSetupRelayStatus(snapshots)   (live per-host relay verdicts)

(() => {
  const SEEN_KEY = 'comfyuiwatcher-setup-seen';
  let panelEl = null;

  function line(text, cls) {
    const el = document.createElement('p');
    el.className = cls || 'setup-text';
    el.textContent = text;
    return el;
  }

  function createSetupPanel() {
    const panel = document.createElement('div');
    panel.className = 'settings-panel setup-panel';
    panel.hidden = true;

    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Step progress for ComfyUI — one manual step';

    panel.append(
      title,
      line(
        'ComfyUI sends step counts only to the client that submitted a job, so this widget cannot '
        + 'see progress for anything you queue from the ComfyUI web UI. A small relay node fixes '
        + 'it. Without the relay a card still shows the host, the queue, the model and whether a '
        + 'job is running — but no step X/Y, rate or ETA.',
      ),
    );

    // The steps. Numbered, because this is the one procedure in the app.
    const steps = document.createElement('ol');
    steps.className = 'setup-steps';
    for (const t of [
      'Open the folder below — it was installed with this app.',
      'Copy the whole folder into your ComfyUI custom_nodes directory.',
      'Restart ComfyUI. Its log will print "comfyuiWATCHER progress relay installed".',
      'Repeat for every ComfyUI host you watch. Training hosts (ai-toolkit) need none of this.',
      'Bonus: the same folder adds five "Watcher" nodes to ComfyUI\'s node menu — step, rate, '
      + 'elapsed and ETA drawn on the canvas itself, in whichever face you like.',
    ]) {
      const li = document.createElement('li');
      li.textContent = t;
      steps.appendChild(li);
    }
    panel.appendChild(steps);

    // Where it is, plus a button that opens it — retyping a path out of a dialog is how people
    // end up copying the wrong thing.
    const pathRow = document.createElement('div');
    pathRow.className = 'setup-path-row';
    const pathEl = document.createElement('code');
    pathEl.className = 'setup-path';
    pathEl.textContent = '…';
    const openBtn = document.createElement('button');
    openBtn.className = 'settings-add-btn';
    openBtn.textContent = 'Open folder';
    openBtn.addEventListener('click', async () => {
      const res = await window.comfyuiWatcher.revealRelay();
      if (!res?.ok) {
        pathEl.textContent = res?.error ?? 'could not open the folder';
        pathEl.classList.add('setup-path--error');
      }
    });
    pathRow.append(pathEl, openBtn);
    panel.appendChild(pathRow);

    const target = document.createElement('div');
    target.className = 'setup-target';
    target.textContent = 'Copy to:  <your ComfyUI>/custom_nodes/comfyui-watcher-relay/';
    panel.appendChild(target);

    // Live verdict per host. The honest three-state: confirmed, not seen yet, or nothing to say.
    const status = document.createElement('div');
    status.className = 'setup-status';
    panel.appendChild(status);

    const done = document.createElement('button');
    done.className = 'settings-add-btn setup-done';
    done.textContent = 'Got it';
    done.addEventListener('click', () => {
      panel.hidden = true;
      localStorage.setItem(SEEN_KEY, '1');
    });
    panel.appendChild(done);

    panelEl = panel;

    window.comfyuiWatcher.getRelayInfo().then((info) => {
      pathEl.textContent = info?.dir ?? 'unknown';
      if (info && !info.exists) {
        pathEl.textContent = `${info.dir} (missing — reinstall, or copy comfyui-relay/ from the repo)`;
        pathEl.classList.add('setup-path--error');
      }
    });

    return panel;
  }

  /**
   * Per-host relay verdicts from the live snapshots. Only ComfyUI hosts appear: `relay` is
   * undefined on a training host, which is not the same as false.
   */
  function updateSetupRelayStatus(snapshots) {
    if (!panelEl) return;
    const status = panelEl.querySelector('.setup-status');
    const rows = [];
    for (const [name, snap] of Object.entries(snapshots || {})) {
      if (!snap || snap.host?.kind === 'aitoolkit') continue;
      if (snap.relay === true) rows.push([name, 'relay active', 'setup-ok']);
      else if (snap.relay === false) rows.push([name, 'no relay — steps unavailable', 'setup-warn']);
      else rows.push([name, 'unknown until a job runs', 'setup-dim']);
    }
    status.replaceChildren();
    if (!rows.length) return;
    for (const [name, text, cls] of rows) {
      const row = document.createElement('div');
      row.className = `setup-status-row ${cls}`;
      const n = document.createElement('span');
      n.className = 'setup-status-host';
      n.textContent = name;
      const v = document.createElement('span');
      v.textContent = text;
      row.append(n, v);
      status.appendChild(row);
    }
  }

  function toggleSetupPanel() {
    if (!panelEl) return;
    panelEl.hidden = !panelEl.hidden;
    if (!panelEl.hidden) localStorage.setItem(SEEN_KEY, '1');
  }

  /** First launch only — after that it is on the button and stays out of the way. */
  function maybeShowSetupPanel() {
    if (!panelEl) return;
    if (!localStorage.getItem(SEEN_KEY)) panelEl.hidden = false;
  }

  window.Widgets = window.Widgets || {};
  window.Widgets.createSetupPanel = createSetupPanel;
  window.Widgets.toggleSetupPanel = toggleSetupPanel;
  window.Widgets.maybeShowSetupPanel = maybeShowSetupPanel;
  window.Widgets.updateSetupRelayStatus = updateSetupRelayStatus;
})();
