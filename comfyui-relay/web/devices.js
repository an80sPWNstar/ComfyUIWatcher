// Which GPU(s) is this workflow actually using?
//
// ComfyUI reports EVERY torch device it can see (server.py's /system_stats builds its list from
// model_management.get_all_torch_devices(), primary device first). A rack with four cards therefore
// answers with four devices whether or not the graph on screen touches more than one — which is
// exactly the thing Bryan did not want the node to show.
//
// TWO SOURCES OF TRUTH, in order:
//   1. THE GRAPH. ComfyUI-MultiGPU (installed on New Main) puts a `device` widget on its loaders
//      and wrappers, whose values are the strings "cpu", "cuda:0", "cuda:1", "xpu:0" ... (see its
//      device_utils.get_device_list). If any node on the canvas names a device, those ARE the
//      devices the run will use, and nothing else is shown.
//   2. NOTHING NAMES ONE → the workflow runs wherever ComfyUI itself is, which is devices[0].
//
// A muted or bypassed node is skipped: it will not run, so it will not touch a card, and lighting
// up a second GPU because of a disabled loader would be a lie.
//
// PURE: no DOM, no ComfyUI — the caller flattens LiteGraph nodes into {mode, values:[{name,value}]}.

// Whole-string match only. Every device label ComfyUI can produce, with an optional index.
//
// TWO SPELLINGS, because there are two multi-GPU systems and they disagree:
//   - ComfyUI CORE (comfy_extras/nodes_multigpu.py — Select Model/CLIP/VAE Device) offers
//     "default", "cpu", "gpu:0", "gpu:1" … from model_management.get_gpu_device_options(). The
//     index is into get_all_torch_devices(), which appends torch.device("cuda", i) in order, so
//     "gpu:1" IS the device with index 1.
//   - ComfyUI-MultiGPU (the custom pack) offers "cpu", "cuda:0", "cuda:1", "xpu:0" …
// "default" is deliberately NOT a device: it means "wherever ComfyUI would have put it anyway",
// which is the primary — the same thing the no-selection fallback shows.
export const DEVICE_RE = /^(cuda|xpu|npu|mlu|mps|cpu|privateuseone|hip|directml|gpu)(:\d+)?$/i;

// The core node that splits sampling across cards. Its widget is a COUNT, not a device: it uses
// the primary plus the first (max_gpus - 1) other devices, so nothing in the graph ever spells out
// which cards those are. See comfy/multigpu.py create_multigpu_deepclones.
export const SPLIT_NODE_TYPES = new Set(['MultiGPU_WorkUnits']);

/** "cuda:1" for an indexed device, "cpu" for one without. */
export function deviceLabel(device) {
  if (!device || !device.type) return null;
  return device.index == null ? String(device.type) : `${device.type}:${device.index}`;
}

const isSkipped = (node) => node?.mode === 2 || node?.mode === 4; // 2 muted, 4 bypassed

/** Device labels named by the graph itself. Empty means "the graph does not choose". */
export function selectedDeviceLabels(nodes) {
  const found = [];
  for (const node of nodes || []) {
    // A node that will not run cannot be using a card.
    if (isSkipped(node)) continue;
    for (const widget of node?.values || []) {
      const value = typeof widget?.value === 'string' ? widget.value.trim() : null;
      if (!value || !DEVICE_RE.test(value)) continue;
      const label = value.toLowerCase();
      if (!found.includes(label)) found.push(label);
    }
  }
  return found;
}

/**
 * How many cards core ComfyUI's "MultiGPU CFG Split" will spread sampling over. The largest wins:
 * two split nodes in one graph do not add up, they each clone across that many devices.
 *
 * Returns 0 when no such node is running, which is the everyday case.
 */
export function splitDeviceCount(nodes) {
  let most = 0;
  for (const node of nodes || []) {
    if (isSkipped(node) || !SPLIT_NODE_TYPES.has(node?.type)) continue;
    for (const widget of node?.values || []) {
      if (widget?.name !== 'max_gpus') continue;
      const n = Number(widget.value);
      if (Number.isFinite(n) && n > most) most = Math.floor(n);
    }
  }
  return most;
}

/** Does this /system_stats device answer to that label? Handles both spellings. */
function deviceMatches(device, label) {
  const text = String(label).toLowerCase();
  if (text === deviceLabel(device)?.toLowerCase()) return true; // "cuda:1"
  const gpu = /^gpu:(\d+)$/.exec(text); // core's vendor-agnostic "gpu:1"
  return !!gpu && String(device?.type).toLowerCase() !== 'cpu' && device?.index === Number(gpu[1]);
}

/**
 * The devices to draw, and WHY they were chosen — the face prints that, because "one card shown"
 * means something different when the graph pinned it than when we simply fell back to the primary.
 *
 * `cpu` is never a row: it has no VRAM, and a workflow pinning a text encoder to the CPU should not
 * make the node grow a meaningless bar.
 */
export function pickDevices(stats, labels, splitCount = 0) {
  const all = (stats?.devices || []).filter((d) => d && d.type);
  const gpus = all.filter((d) => String(d.type).toLowerCase() !== 'cpu');
  if (!gpus.length) return { devices: [], source: 'none' };
  const wanted = (labels || []).map((s) => String(s).toLowerCase());
  const chosen = gpus.filter((d) => wanted.some((label) => deviceMatches(d, label)));

  // CFG Split names no devices at all — it takes a COUNT. The cards it will use are the primary
  // (which /system_stats puts first) plus the next (max_gpus - 1) in torch index order. Union it
  // with anything explicitly selected, because a graph can do both.
  if (splitCount > 1) {
    const primary = gpus[0];
    const rest = gpus.filter((d) => d !== primary).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const device of [primary, ...rest.slice(0, splitCount - 1)]) {
      if (!chosen.includes(device)) chosen.push(device);
    }
  }

  if (chosen.length) {
    // Keep the server's own order, so the primary stays on top however the union was built.
    return { devices: gpus.filter((d) => chosen.includes(d)), source: 'workflow' };
  }
  // The graph named nothing (or named only the CPU / "default"): ComfyUI runs on its primary
  // device, which /system_stats puts first on purpose.
  return { devices: [gpus[0]], source: 'primary' };
}

/**
 * Every GPU ComfyUI can see, for the node that deliberately ignores what the workflow selected —
 * the "what is my whole box doing" view, next to the scoped one. Same shape as pickDevices so the
 * face cannot tell the difference; `source: 'all'` is what it prints.
 *
 * Still no CPU row: it has no VRAM, and a row that can only ever say "n/a" is furniture.
 */
export function allDevices(stats) {
  const gpus = (stats?.devices || []).filter(
    (d) => d && d.type && String(d.type).toLowerCase() !== 'cpu',
  );
  return { devices: gpus, source: gpus.length ? 'all' : 'none' };
}

/**
 * WHICH GPU STACK IS THIS? The build tag is the only reliable tell — PyTorch's ROCm wheels report
 * `torch.cuda`, devices of type "cuda", and even a `cuda:0` device name, so an AMD box and an
 * NVIDIA box look identical in /system_stats apart from `pytorch_version`. Same rule the desktop
 * widget's detectAccelerator() uses.
 *
 * An untagged build (source or conda) falls back to the card's own name — a name never yields a
 * version, but it does identify the stack.
 */
export function acceleratorFromStats(stats) {
  const torch = String(stats?.system?.pytorch_version || '');
  if (/\+rocm/i.test(torch)) return 'ROCm';
  if (/\+cu\d/i.test(torch)) return 'CUDA';
  if (/\+xpu/i.test(torch)) return 'XPU';
  if (/\+cpu/i.test(torch)) return 'CPU';
  const names = (stats?.devices || []).map((d) => String(d?.name || '')).join(' ');
  if (/\b(amd|radeon|instinct|gfx\d)/i.test(names)) return 'ROCm';
  if (/\b(nvidia|geforce|rtx|gtx|tesla|quadro)/i.test(names)) return 'CUDA';
  return null; // unknown is a real answer; the face prints nothing rather than guessing
}

/**
 * VRAM for one device entry. `vram_free` is the CARD's free memory (torch reads it from the driver),
 * so `used` includes anything else on the box — another ComfyUI, a game, a training run. That is
 * the number worth watching, and it is why this is not labelled "used by ComfyUI".
 */
export function deviceVram(device) {
  const total = Number(device?.vram_total);
  const free = Number(device?.vram_free);
  if (!(total > 0) || !Number.isFinite(free)) return null;
  const used = Math.max(0, total - free);
  return { total, free, used, fraction: Math.min(1, used / total) };
}

/**
 * The card, without the noise. ComfyUI's get_torch_device_name returns the WHOLE thing:
 * "cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync" — device label in front, allocator on the
 * back — so both ends have to come off before the vendor words do. Verified against the live
 * :8189 instance 2026-08-15; splitting on the first colon (which is what this did at first)
 * returned the string "cuda" and printed it beside every card.
 */
export function shortDeviceName(name) {
  if (!name) return null;
  let text = String(name).trim();
  text = text.replace(/^[a-z]+:\d+\s*/i, ''); // leading "cuda:0 "
  text = text.split(/\s+:\s+/)[0].trim(); // trailing " : cudaMallocAsync"
  text = text.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '').replace(/^AMD\s+/i, '');
  return text || null;
}

export function fmtGiB(bytes) {
  if (!Number.isFinite(bytes)) return '--';
  const gib = bytes / 1024 ** 3;
  return (gib >= 100 ? gib.toFixed(0) : gib.toFixed(1)) + '';
}
