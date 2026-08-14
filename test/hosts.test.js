const assert = require('assert');
// hosts.js require()s electron for app.getPath, but only configPath()/load()/save() touch it —
// validate() is pure, and outside Electron `require('electron')` is just a path string, so the
// destructured `app` is undefined and never used here.
const { validate, DEFAULT_HOSTS } = require('../src/config/hosts');

// THE ARRAY ORDER IS THE RACK ORDER — validate must never sort or regroup, or dragging a card
// would appear to do nothing (or something else).
{
  const out = validate([
    { name: 'C', url: 'http://127.0.0.1:8190' },
    { name: 'A', url: 'http://127.0.0.1:8188' },
    { name: 'B', url: 'http://127.0.0.1:8189' },
  ]);
  assert.deepStrictEqual(out.map((h) => h.name), ['C', 'A', 'B'], 'order is preserved verbatim');
}

// hidden:true survives a round trip (it is what keeps an entry without watching it); anything
// else about `hidden` is dropped, so hosts.json carries the flag only where it means something.
{
  const out = validate([
    { name: 'Off', url: 'http://127.0.0.1:8189', hidden: true },
    { name: 'On', url: 'http://127.0.0.1:8188', hidden: false },
    { name: 'Junk', url: 'http://127.0.0.1:8190', hidden: 'yes' },
  ]);
  assert.strictEqual(out[0].hidden, true, 'hidden:true is kept');
  assert.ok(!('hidden' in out[1]), 'hidden:false carries no flag');
  assert.ok(!('hidden' in out[2]), 'a non-boolean hidden is not honoured');
}

// A hidden host is still a host: it keeps its kind and token, and an all-hidden list is NOT empty
// (that would fall back to the defaults and silently resurrect hosts the user hid).
{
  const out = validate([
    { name: 'Trainer', url: 'http://127.0.0.1:8675', kind: 'aitoolkit', token: 'abc', hidden: true },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'aitoolkit');
  assert.strictEqual(out[0].token, 'abc');
  assert.strictEqual(out[0].hidden, true);
  assert.notDeepStrictEqual(out, DEFAULT_HOSTS, 'an all-hidden list must not fall back to defaults');
}

console.log('hosts.test.js: all assertions passed');
