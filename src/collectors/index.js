// Collector registry. One entry per host `kind`.
//
// Every collector honours the same tiny contract, and nothing above this file knows which kind a
// host is:
//   new Collector(host, onUpdate) / .start() / .stop()
//   onUpdate(hostName, snapshot) where snapshot is
//     {host, status, lastError, queueRemaining, system, currentJob}
// and currentJob is either null or {step, maxSteps, stepsPerSec, etaSec, elapsedSec, finished,
// node, nodeName, model, size, ...kind-specific extras}. The kind-specific extras (frames/batch
// for generation, rank/loss for training) are the only difference the card sees.
//
// Adding a trainer (Kohya, Musubi, OneTrainer) means adding a file and one line here.

const { ComfyUIClient } = require('./comfyui-client');
const { AIToolkitClient } = require('./aitoolkit-client');

const COLLECTORS = {
  comfyui: ComfyUIClient,
  aitoolkit: AIToolkitClient,
};

/** Unknown kinds fall back to comfyui — hosts.js validate() already normalises, this is a belt. */
function createCollector(host, onUpdate) {
  const Collector = COLLECTORS[host?.kind] ?? ComfyUIClient;
  return new Collector(host, onUpdate);
}

module.exports = { createCollector, COLLECTORS };
