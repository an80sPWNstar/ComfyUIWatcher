// One card per configured ComfyUI host. Plain function, no framework — same pattern as
// guiTOP's renderer/widgets: build/update DOM directly, escape all text content.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function fmtSec(s) {
  if (s == null || !Number.isFinite(s)) return '--';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function fmtRate(stepsPerSec) {
  if (stepsPerSec == null || !Number.isFinite(stepsPerSec) || stepsPerSec <= 0) return '--';
  // ComfyUI's own UI reports s/it once below 1 it/s, it/s above — match that convention.
  if (stepsPerSec >= 1) return `${stepsPerSec.toFixed(2)} it/s`;
  return `${(1 / stepsPerSec).toFixed(2)} s/it`;
}

function createCard(hostName) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.dataset.host = hostName;
  card.innerHTML = `
    <div class="job-card-header">
      <span class="job-card-name"></span>
      <span class="job-card-status"></span>
    </div>
    <div class="job-card-body">
      <div class="job-card-node"></div>
      <div class="job-card-progress-track"><div class="job-card-progress-fill"></div></div>
      <div class="job-card-stats">
        <span class="job-card-step"></span>
        <span class="job-card-rate"></span>
        <span class="job-card-elapsed"></span>
        <span class="job-card-eta"></span>
      </div>
      <div class="job-card-queue"></div>
      <div class="job-card-system"></div>
    </div>
  `;
  return card;
}

function updateCard(card, hostName, snapshot) {
  card.querySelector('.job-card-name').textContent = hostName;

  const statusEl = card.querySelector('.job-card-status');
  const status = snapshot?.status ?? 'offline';
  statusEl.textContent = status;
  statusEl.className = `job-card-status job-card-status--${escapeHtml(status)}`;

  const job = snapshot?.currentJob;
  const nodeEl = card.querySelector('.job-card-node');
  const fill = card.querySelector('.job-card-progress-fill');
  const stepEl = card.querySelector('.job-card-step');
  const rateEl = card.querySelector('.job-card-rate');
  const elapsedEl = card.querySelector('.job-card-elapsed');
  const etaEl = card.querySelector('.job-card-eta');

  card.classList.toggle('job-card--finished-success', job?.finished === 'success');
  card.classList.toggle('job-card--finished-error', job?.finished === 'error');

  if (job && job.finished) {
    // Held "just finished" state — collector keeps it for ~10s, elapsed is frozen.
    fill.classList.remove('job-card-progress-fill--indeterminate');
    nodeEl.textContent = job.finished === 'success' ? 'Finished ✓' : 'Failed ✗';
    fill.style.width = job.finished === 'success' ? '100%' : `${job.maxSteps ? Math.min(100, (100 * job.step) / job.maxSteps) : 0}%`;
    stepEl.textContent = job.maxSteps != null ? `Step ${job.step ?? 0}/${job.maxSteps}` : '--';
    rateEl.textContent = '';
    elapsedEl.textContent = `Took ${fmtSec(job.elapsedSec)}`;
    etaEl.textContent = '';
  } else if (job) {
    nodeEl.textContent = job.node ? `Running: ${job.nodeName ?? job.node}` : 'Running';
    // No step numbers (foreign job — ComfyUI only sends progress to the submitting client):
    // animated indeterminate bar instead of a stuck-empty one.
    fill.classList.toggle('job-card-progress-fill--indeterminate', job.maxSteps == null);
    const pct = job.maxSteps ? Math.min(100, (100 * job.step) / job.maxSteps) : 0;
    fill.style.width = `${pct}%`;
    stepEl.textContent = job.maxSteps != null ? `Step ${job.step ?? 0}/${job.maxSteps}` : '';
    rateEl.textContent = fmtRate(job.stepsPerSec);
    elapsedEl.textContent = `Elapsed ${fmtSec(job.elapsedSec)}`;
    etaEl.textContent = job.etaSec != null ? `ETA ${fmtSec(job.etaSec)}` : '';
  } else {
    nodeEl.textContent = status === 'online' ? 'Idle' : '--';
    fill.classList.remove('job-card-progress-fill--indeterminate');
    fill.style.width = '0%';
    stepEl.textContent = '--';
    rateEl.textContent = '--';
    elapsedEl.textContent = '';
    etaEl.textContent = '';
  }

  const queueEl = card.querySelector('.job-card-queue');
  queueEl.textContent = snapshot?.queueRemaining != null ? `Queue: ${snapshot.queueRemaining} pending` : '';

  const sysEl = card.querySelector('.job-card-system');
  const sys = snapshot?.system;
  if (sys && Array.isArray(sys.gpus) && sys.gpus.length) {
    sysEl.textContent = sys.gpus
      .map((g, i) => `GPU${i}: ${g.gpu_utilization ?? '--'}% util, ${g.vram_used_percent != null ? g.vram_used_percent.toFixed(0) : '--'}% VRAM`)
      .join(' | ');
  } else {
    sysEl.textContent = '';
  }
}

// Plain <script> include (no bundler, no CommonJS in the renderer) — same pattern guiTOP's
// widgets use. Expose via a small global namespace instead of module.exports.
window.Widgets = window.Widgets || {};
window.Widgets.createCard = createCard;
window.Widgets.updateCard = updateCard;
