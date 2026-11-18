'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, museArgs, render, parseDotenv, parseLogin } = require('../cli/muse-relay');

const RELAY = path.join(__dirname, '..', 'cli', 'muse-relay');
const FIXTURES = path.join(__dirname, 'fixtures', 'muse');
const fixture = (n) => fs.readFileSync(path.join(FIXTURES, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function play(events) {
  const st = { bol: true };
  return { out: events.map((e) => render(e, st)).join(''), st };
}

test('parseArgs: run flags and prompt words', () => {
  const a = parseArgs(['run', '--model', 'muse-spark-1.3', '--effort', 'low', '--new', 'fix', 'the', 'bug']);
  assert.deepStrictEqual(a.opts, { model: 'muse-spark-1.3', effort: 'low', fresh: true, session: null });
  assert.strictEqual(a.prompt, 'fix the bug');
  assert.strictEqual(parseArgs(['run']).opts.model, 'muse-wonder-full-1.0');
  assert.strictEqual(parseArgs(['run', '--', '--new']).prompt, '--new');
});

test('parseArgs: bad input, and contributor models are refused', () => {
  assert.throws(() => parseArgs(['run', '--model']), /needs a value/);
  assert.throws(() => parseArgs(['run', '--bogus', 'x']), /unknown option/);
  assert.throws(() => parseArgs(['run', '--new', '--session', 'x', 'p']), /mutually exclusive/);
  assert.throws(() => parseArgs(['run', '--effort', 'ultra', 'p']), /--effort must be/);
  assert.throws(() => parseArgs(['run', '--model', 'muse-wonder-full-1.0-contributor', 'p']), /contributor models are off/);
});

test('museArgs: headless json, the session, a clean context, permissions skipped', () => {
  const a = museArgs({ model: 'm', effort: 'max' }, 's1', '/t/p.txt');
  assert.deepStrictEqual(a.slice(0, 6), ['exec', '--json', '--session-id', 's1', '--model', 'm']);
  assert.deepStrictEqual(a.slice(6, 8), ['--reasoning-effort', 'max']);
  for (const f of ['--no-foreign-personal-context', '--disable-reminders', 'managed_hooks_path=null', 'hooks={}', '--disable-approval', '--trust-workspace']) assert.ok(a.includes(f), f);
  assert.deepStrictEqual(a.slice(a.indexOf('--contributor-mode'), a.indexOf('--contributor-mode') + 2), ['--contributor-mode', 'off']);
  assert.deepStrictEqual(a.slice(-2), ['--prompt-file', '/t/p.txt']);
  assert.ok(!museArgs({ model: 'm' }, 's1', 'p').includes('--reasoning-effort'));
});

test('render: two turns with a tool call', () => {
  const { out, st } = play(fixture('two-turn.ndjson'));
  assert.match(out, /^\[tool\] read_file -> Read text file `note\.txt`\.\nThe file contains `hello-fixture`\.\nnote\.txt$/);
  assert.strictEqual(st.session, '00000000-0000-0000-0000-000000000001');
  assert.strictEqual(st.terminal, 'completed');
  assert.strictEqual(st.model, 'muse-spark-1.3');
  assert.deepStrictEqual(st.tokens, { in: 30849, out: 44 }); // the last turn's run.usage (two turns replayed: 61465 + 30849)
  assert.ok(!st.error);
});

test('render: a failed run is surfaced verbatim', () => {
  const { st } = play(fixture('bad-model.ndjson'));
  assert.strictEqual(st.terminal, 'failed');
  assert.match(st.error, /^model `nope-model` does not exist or you lack access/);
});

test('parseDotenv: keys with shell metacharacters, quotes, last one wins', () => {
  assert.strictEqual(parseDotenv('A=1\nMETA_API_KEY=abc|def$x\n', 'META_API_KEY'), 'abc|def$x');
  assert.strictEqual(parseDotenv('export META_API_KEY="q|1"\n', 'META_API_KEY'), 'q|1');
  assert.strictEqual(parseDotenv('META_API_KEY=old\nMETA_API_KEY=new\n', 'META_API_KEY'), 'new');
  assert.strictEqual(parseDotenv('A=1\n', 'META_API_KEY'), null);
});

function sandbox(fixtureName, exitCode = 0) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-relay-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'muse'), `#!/bin/sh
printf '%s\\n' "$@" > "${tmp}/args"
printf '%s' "$META_API_KEY" > "${tmp}/key"
while [ $# -gt 0 ]; do [ "$1" = --prompt-file ] && cp "$2" "${tmp}/prompt"; shift; done
echo "muse: workspace root: /work (cwd default)" >&2
cat "${path.join(FIXTURES, fixtureName)}"
exit ${exitCode}
`, { mode: 0o755 });
  const cwd = fs.mkdtempSync(path.join(tmp, 'work-'));
  const env = { PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, HOME: tmp, MUSE_RELAY_CACHE_DIR: path.join(tmp, 'cache') };
  const run = (args, opts = {}) => spawnSync(process.execPath, [RELAY, 'run', ...args], { cwd, env: { ...env, ...opts.env }, encoding: 'utf8', input: opts.input });
  const args = () => fs.readFileSync(path.join(tmp, 'args'), 'utf8').trim().split('\n');
  const read = (n) => fs.readFileSync(path.join(tmp, n), 'utf8');
  return { tmp, cwd, run, args, read, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('run end to end against a fake muse replaying a fixture: sessions per cwd, --new, stdin, .env key', () => {
  const s = sandbox('two-turn.ndjson');
  try {
    fs.writeFileSync(path.join(s.cwd, '.env'), 'OTHER=1\nMETA_API_KEY=k|from-dotenv\n');
    const r2 = s.run(['--effort', 'low', 'read', 'note.txt']);
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /\[tool\] read_file -> /);
    assert.match(r2.stdout, /\nmodel: muse-spark-1\.3 \(\d+ tokens in, \d+ out\)\nsession: 00000000-0000-0000-0000-000000000001\n$/);
    assert.doesNotMatch(r2.stderr, /workspace root/);
    assert.strictEqual(s.read('prompt'), 'read note.txt');
    assert.strictEqual(s.read('key'), 'k|from-dotenv');
    assert.match(r2.stderr, /warning: using META_API_KEY: this bills the Muse API per token, not your plan/);
    const first = s.args();
    assert.deepStrictEqual(first.slice(4, 6), ['--model', 'muse-wonder-full-1.0']);
    assert.notStrictEqual(first[3], '00000000-0000-0000-0000-000000000001'); // a fresh session id

    s.run(['again']);
    assert.strictEqual(s.args()[3], '00000000-0000-0000-0000-000000000001');
    s.run(['--new', 'fresh']);
    assert.notStrictEqual(s.args()[3], '00000000-0000-0000-0000-000000000001');
    s.run(['--session', 'abc', 'that one']);
    assert.strictEqual(s.args()[3], 'abc');

    const r3 = s.run([], { input: '--starts like a flag\nand spans lines', env: { META_API_KEY: 'from-env' } });
    assert.strictEqual(r3.status, 0, r3.stderr);
    assert.strictEqual(s.read('prompt'), '--starts like a flag\nand spans lines');
    assert.strictEqual(s.read('key'), 'from-env');
  } finally {
    s.done();
  }
});

test('run: a failed turn exits 1 with the reason once', () => {
  const s = sandbox('bad-model.ndjson', 1);
  try {
    const r = s.run(['hi']);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stderr.match(/nope-model/g).length, 1);
  } finally {
    s.done();
  }
});

test('export-key: prints the stored key for .env, never to a terminal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-relay-test-'));
  try {
    fs.mkdirSync(path.join(tmp, '.config', 'muse'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.config', 'muse', 'auth.json'), JSON.stringify({ schema_version: 1, providers: { meta: { api_key: 'stored|key' } } }));
    const r = spawnSync(process.execPath, [RELAY, 'export-key'], { cwd: tmp, env: { PATH: process.env.PATH, HOME: tmp }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'META_API_KEY=stored|key\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const PLAN = { schema_version: 1, providers: { meta: { access_token: 'tok', api_key: 'derived|key', mechanism: 'oauth', obtained_via: 'device_code' } } };
const planB64 = Buffer.from(JSON.stringify(PLAN)).toString('base64');
const authPath = (s) => path.join(s.tmp, '.config', 'muse', 'auth.json');

test('parseLogin: a base64 login file, nothing else', () => {
  assert.deepStrictEqual(parseLogin(planB64 + '\n'), PLAN);
  assert.strictEqual(parseLogin('not base64 json'), null);
  assert.strictEqual(parseLogin(Buffer.from('{"providers":{}}').toString('base64')), null);
  const apiOnly = { providers: { meta: { api_key: 'k', access_token: 't', mechanism: 'api_key' } } };
  assert.strictEqual(parseLogin(Buffer.from(JSON.stringify(apiOnly)).toString('base64')), null); // bills the API: never imported
});

test('run: MUSE_AUTH_B64 (env or .env) installs the plan login 0600 and META_API_KEY is not passed on', () => {
  for (const where of ['env', 'dotenv']) {
    const s = sandbox('two-turn.ndjson');
    try {
      let env = { META_API_KEY: 'api-key-must-not-win' };
      if (where === 'env') env.MUSE_AUTH_B64 = planB64;
      else fs.writeFileSync(path.join(s.cwd, '.env'), `MUSE_AUTH_B64=${planB64}\nMETA_API_KEY=also-not\n`);
      const r = s.run(['hi'], { env });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(authPath(s), 'utf8')), PLAN);
      assert.strictEqual(fs.statSync(authPath(s)).mode & 0o777, 0o600);
      assert.strictEqual(s.read('key'), '');
      assert.doesNotMatch(r.stderr, /bills the Muse API/);
    } finally {
      s.done();
    }
  }
});

test('run: an existing plan login beats META_API_KEY; an api_key login does not', () => {
  const s = sandbox('two-turn.ndjson');
  try {
    fs.mkdirSync(path.dirname(authPath(s)), { recursive: true });
    fs.writeFileSync(authPath(s), JSON.stringify(PLAN));
    assert.strictEqual(s.run(['hi'], { env: { META_API_KEY: 'x' } }).status, 0);
    assert.strictEqual(s.read('key'), '');
    fs.writeFileSync(authPath(s), JSON.stringify({ providers: { meta: { api_key: 'k', mechanism: 'api_key' } } }));
    const r = s.run(['hi'], { env: { META_API_KEY: 'x' } });
    assert.strictEqual(s.read('key'), 'x');
    assert.match(r.stderr, /bills the Muse API/);
    const r2 = s.run(['hi']); // no META_API_KEY: the stored api_key login is used, with the same warning
    assert.match(r2.stderr, /warning: using the stored API-key login: this bills the Muse API/);
  } finally {
    s.done();
  }
});

test('export-login: prints the login file as MUSE_AUTH_B64 for .env, round-trips', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-relay-test-'));
  try {
    fs.mkdirSync(path.join(tmp, '.config', 'muse'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.config', 'muse', 'auth.json'), JSON.stringify(PLAN));
    const r = spawnSync(process.execPath, [RELAY, 'export-login'], { cwd: tmp, env: { PATH: process.env.PATH, HOME: tmp }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, `MUSE_AUTH_B64=${planB64}\n`);
    assert.deepStrictEqual(parseLogin(parseDotenv(r.stdout, 'MUSE_AUTH_B64')), PLAN);
    const none = spawnSync(process.execPath, [RELAY, 'export-login'], { cwd: tmp, env: { PATH: process.env.PATH, HOME: path.join(tmp, 'nobody') }, encoding: 'utf8' });
    assert.strictEqual(none.status, 1);
    assert.match(none.stderr, /no Muse login/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
