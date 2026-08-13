const assert = require('assert');
const { ComfyUIClient } = require('../src/collectors/comfyui-client');

function makeClient() {
  return new ComfyUIClient({ name: 'test', url: 'http://127.0.0.1:1' }, () => {});
}

// The relay verdict is three-state on purpose. "No relay" is a claim the setup panel prints to the
// user, so it is only made once a job has demonstrably been running without any watcher.* traffic.

// Idle host: nothing has run, so nothing is known.
{
  const client = makeClient();
  assert.strictEqual(client._relayState(), null, 'an idle host proves nothing either way');
}

// A job just started — a relay would not necessarily have spoken yet.
{
  const client = makeClient();
  client._firstJobSeenAtMs = Date.now();
  assert.strictEqual(client._relayState(), null, 'no verdict in the first seconds of a job');
}

// A job has been running well past the grace period with no watcher.* message: relay is missing.
{
  const client = makeClient();
  client._firstJobSeenAtMs = Date.now() - 60000;
  assert.strictEqual(client._relayState(), false, 'silent through a whole job means no relay');
}

// One watcher.* message is proof, and it outranks any amount of prior silence.
{
  const client = makeClient();
  client._firstJobSeenAtMs = Date.now() - 60000;
  client._handleMessage(JSON.stringify({
    type: 'watcher.progress',
    data: { value: 3, max: 20, prompt_id: 'p1', node: '9' },
  }));
  assert.strictEqual(client.relaySeen, true);
  assert.strictEqual(client._relayState(), true, 'watcher.* traffic can only come from the relay');
  // ...and the message must still be handled as the original type, not just counted.
  assert.strictEqual(client.currentJob.step, 3);
  assert.strictEqual(client.currentJob.maxSteps, 20);
}

// A plain (non-relayed) message must not be mistaken for proof.
{
  const client = makeClient();
  client._handleMessage(JSON.stringify({
    type: 'status',
    data: { status: { exec_info: { queue_remaining: 2 } } },
  }));
  assert.strictEqual(client.relaySeen, false, 'broadcast messages say nothing about the relay');
  assert.strictEqual(client.queueRemaining, 2);
}

// The verdict rides on the snapshot, since the setup panel reads the same stream the cards do.
{
  let snap = null;
  const client = new ComfyUIClient({ name: 'test', url: 'http://x' }, (_n, s) => { snap = s; });
  client._emit();
  assert.strictEqual(snap.relay, null);
  client.relaySeen = true;
  client._emit();
  assert.strictEqual(snap.relay, true);
}

console.log('relay-detect tests passed');
