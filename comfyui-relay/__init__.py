# comfyuiWATCHER progress relay.
#
# ComfyUI sends every execution message (progress, executing, execution_start,
# execution_success/error, ...) ONLY to the client that submitted the prompt
# (send_sync(..., server.client_id); sid=None would broadcast but is never used for these).
# A passive monitor like comfyuiWATCHER therefore never sees step progress for jobs queued
# from the web UI. This shim wraps PromptServer.send_sync and re-emits each targeted
# execution message as a broadcast copy under a "watcher."-prefixed event type, so ComfyUI's
# own frontends ignore it and only watchers that opt in consume it.
#
# Install: copy this folder into ComfyUI/custom_nodes/ and restart ComfyUI.
# No graph nodes are registered; the patch happens at import time.

import logging

RELAY_EVENTS = {
    "progress",
    "executing",
    "execution_start",
    "execution_success",
    "execution_error",
    "execution_cached",
    "execution_interrupted",
}

try:
    from server import PromptServer

    if not getattr(PromptServer, "_watcher_relay_installed", False):
        _orig_send_sync = PromptServer.send_sync

        def _relay_send_sync(self, event, data, sid=None):
            _orig_send_sync(self, event, data, sid)
            # Only duplicate string events we care about, and only when they were targeted
            # (sid=None ones are already broadcast; binary events have non-str types).
            if isinstance(event, str) and event in RELAY_EVENTS and sid is not None:
                try:
                    _orig_send_sync(self, "watcher." + event, data, None)
                except Exception:  # never let the relay break real message delivery
                    logging.exception("comfyuiWATCHER relay failed to broadcast %s", event)

        PromptServer.send_sync = _relay_send_sync
        PromptServer._watcher_relay_installed = True
        logging.info("comfyuiWATCHER progress relay installed (broadcasting watcher.* events)")
except Exception:
    logging.exception("comfyuiWATCHER progress relay failed to install")

# ── Batch size of a list-expanded node (added 2026-08-13) ──
# A "dataset" workflow feeds a list of prompts into one graph. ComfyUI runs each downstream node
# once per item, back to back, and its progress bar restarts for every one — so a watcher can COUNT
# the items it has seen but can never know how many are coming: no message carries that number.
# execution._async_map_node_over_list does know it (max_len_input), so broadcast it once per node
# run as watcher.batch. Without this the card honestly shows "IMAGE 3" instead of "IMAGE 3 / 28".
#
# This wraps an internal function, so it is written to fail into a no-op: if the signature ever
# changes, the try/except leaves ComfyUI's own execution untouched and the watcher just loses the
# denominator again.
try:
    import execution
    from server import PromptServer  # re-imported: the block above may have failed

    if not getattr(execution, "_watcher_batch_installed", False):
        _orig_map_over_list = execution._async_map_node_over_list

        async def _watcher_map_over_list(prompt_id, unique_id, obj, input_data_all, func, *args, **kwargs):
            try:
                total = max((len(v) for v in (input_data_all or {}).values()), default=0)
                if total > 1:
                    PromptServer.instance.send_sync(
                        "watcher.batch",
                        {"prompt_id": prompt_id, "node": str(unique_id), "total": total},
                        None,  # broadcast: every watcher, no client is targeted
                    )
            except Exception:
                logging.exception("comfyuiWATCHER relay failed to report a batch size")
            return await _orig_map_over_list(prompt_id, unique_id, obj, input_data_all, func, *args, **kwargs)

        execution._async_map_node_over_list = _watcher_map_over_list
        execution._watcher_batch_installed = True
        logging.info("comfyuiWATCHER relay: batch-size reporting installed")
except Exception:
    logging.exception("comfyuiWATCHER relay failed to install batch-size reporting")

# ── Host build info: the NVIDIA driver version (added 2026-08-14) ──
# ComfyUI's own /system_stats reports comfyui_version, python_version and pytorch_version (which
# carries the CUDA build tag, e.g. 2.13.0+cu130), but NOTHING in ComfyUI reports the NVIDIA DRIVER
# version, and no installed node pack exposes it either — Crystools reads it internally but its
# /crystools/monitor/GPU route returns index and name only (checked against a live 0.33.1 install,
# 2026-08-14). So the watcher asks the relay, which is running inside the process that has the GPU.
#
# pynvml first (Crystools already ships it, so it is usually importable), nvidia-smi as the fallback
# for an install without it. The answer is cached for the life of the process: a driver version does
# not change under a running server, and shelling out per poll would be absurd.
#
# BOTH VENDORS. An AMD box runs the same ComfyUI through ROCm, where pynvml and nvidia-smi do not
# exist — the driver there is the amdgpu kernel module, reported by rocm-smi or readable straight out
# of /sys. Which pair to try first is decided by the torch build (torch.version.hip is set only on a
# ROCm build), so a machine is never asked about a driver it does not have.
_watcher_driver = None


def _watcher_first_line(cmd):
    import subprocess

    out = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    for line in (out.stdout or "").splitlines():
        text = line.strip()
        # rocm-smi prints a banner and a table; the version is the first line carrying digits.
        if text and any(ch.isdigit() for ch in text):
            return text
    return None


def _watcher_is_rocm():
    try:
        import torch

        return bool(getattr(torch.version, "hip", None))
    except Exception:
        return False


def _watcher_driver_nvidia():
    try:
        import pynvml

        pynvml.nvmlInit()
        raw = pynvml.nvmlSystemGetDriverVersion()
        return raw.decode() if isinstance(raw, bytes) else str(raw)
    except Exception:
        pass
    try:
        return _watcher_first_line(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"]
        )
    except Exception:
        return None


def _watcher_driver_amd():
    # The kernel module's own version file, when it is there: no subprocess, no parsing.
    try:
        with open("/sys/module/amdgpu/version", "r") as fh:
            text = fh.read().strip()
            if text:
                return text
    except Exception:
        pass
    for cmd in (
        ["rocm-smi", "--showdriverversion", "--csv"],
        ["rocm-smi", "--showdriverversion"],
    ):
        try:
            found = _watcher_first_line(cmd)
            if found:
                # "Driver version: 6.8.5" / a csv row — keep the version, drop the label.
                return found.split(":")[-1].split(",")[-1].strip()
        except Exception:
            continue
    return None


def _watcher_driver_version():
    global _watcher_driver
    if _watcher_driver is not None:
        return _watcher_driver
    order = (
        (_watcher_driver_amd, _watcher_driver_nvidia)
        if _watcher_is_rocm()
        else (_watcher_driver_nvidia, _watcher_driver_amd)
    )
    for probe in order:
        try:
            found = probe()
        except Exception:
            found = None
        if found:
            _watcher_driver = found
            return _watcher_driver
    return None  # not cached: a transient failure should not pin "unknown" for the whole session


try:
    from aiohttp import web
    from server import PromptServer  # re-imported: the blocks above may have failed

    if not getattr(PromptServer, "_watcher_hostinfo_installed", False):

        @PromptServer.instance.routes.get("/watcher/host_info")
        async def _watcher_host_info(request):
            # Only what the watcher cannot get from stock endpoints. Everything else it already has.
            return web.json_response({"driver": _watcher_driver_version()})

        PromptServer._watcher_hostinfo_installed = True
        logging.info("comfyuiWATCHER relay: /watcher/host_info installed")
except Exception:
    logging.exception("comfyuiWATCHER relay failed to install /watcher/host_info")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
