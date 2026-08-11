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

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
