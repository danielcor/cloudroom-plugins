'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, agyArgs, render, normalizeToken, parseDotenv } = require('../cli/gemini-relay');

const RELAY = path.join(__dirname, '..', 'cli', 'gemini-relay');
const SHIM = path.join(__dirname, '..', 'cli', 'argon');
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function play(events) {
  const st = { bol: true };
  const out = events.map((e) => render(e, st)).join('');
  return { out, st };
}

test('parseArgs: run flags and prompt words', () => {
  const a = parseArgs(['run', '--model', 'gemini-4-carbon-low', '--effort', 'low', '--new', 'fix', 'the', 'bug']);
  assert.deepStrictEqual(a.opts, { model: 'gemini-4-carbon-low', effort: 'low', fresh: true, conversation: null });
  assert.strictEqual(a.prompt, 'fix the bug');
  assert.strictEqual(parseArgs(['run']).prompt, null);
  assert.strictEqual(parseArgs(['run']).opts.model, 'gemini-4-neon-high');
  assert.strictEqual(parseArgs(['run', '--', '--new']).prompt, '--new');
});

test('parseArgs: bad input', () => {
  assert.throws(() => parseArgs(['run', '--model']), /needs a value/);
  assert.throws(() => parseArgs(['run', '--bogus', 'x']), /unknown option/);
  assert.throws(() => parseArgs(['run', '--new', '--conversation', 'x', 'p']), /mutually exclusive/);
});

test('agyArgs: headless stream-json, optional effort and conversation', () => {
  const a = agyArgs({ model: 'm', effort: 'low' }, 'c1');
  assert.deepStrictEqual(a.slice(0, 5), ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.ok(a.includes('--dangerously-skip-permissions'));
  assert.deepStrictEqual(a.slice(-4), ['--effort', 'low', '--conversation', 'c1']);
  assert.ok(!agyArgs({ model: 'm' }, null).includes('--conversation'));
  // agy refuses an --effort that conflicts with an effort-suffixed model id, so the id wins
  assert.ok(!agyArgs({ model: 'gemini-4-carbon-high', effort: 'low' }, null).includes('--effort'));
  assert.ok(agyArgs({ model: 'some-model', effort: 'low' }, null).includes('--effort'));
});

test('render: two turns with a tool call', () => {
  const { out, st } = play(fixture('two-turn.ndjson'));
  assert.match(out, /\[tool\] read_file: \/work\/note\.txt\n {2}-> 1 lines, 14 bytes\n/);
  assert.match(out, /hello-fixture/);
  assert.match(out, /I just read .*hello-fixture/s);
  assert.strictEqual(st.conversation, '00000000-0000-0000-0000-000000000000');
  assert.strictEqual(st.result.status, 'SUCCESS');
  assert.ok(!st.error);
});

test('render: tool output reports the first line, text starts on a fresh line', () => {
  const { out } = play(fixture('tool-error.ndjson'));
  assert.match(out, /\[tool\] run_command: ls \/nonexistent-dir\n {2}-> Command exited with code 2\.\n/);
  assert.match(out, /\n.*No such file or directory/);
});

test('render: error result is surfaced verbatim', () => {
  const { st } = play(fixture('bad-model.ndjson'));
  assert.match(st.error, /^invalid model selection .*nope-model is not recognized/);
});

test('normalizeToken / parseDotenv', () => {
  const json = JSON.stringify({ token: { access_token: 'a', refresh_token: 'r' }, auth_method: 'consumer' });
  const b64 = Buffer.from(json).toString('base64');
  assert.strictEqual(normalizeToken(json + '\n'), json);
  assert.strictEqual(normalizeToken(b64), json);
  assert.strictEqual(normalizeToken('go-keyring-base64:' + b64), json);
  assert.strictEqual(normalizeToken('{"token":{}}'), null);
  assert.strictEqual(normalizeToken('not a token'), null);
  assert.strictEqual(parseDotenv(`A=1\nexport K="${b64}"\n`, 'K'), b64);
  assert.strictEqual(parseDotenv('A=1\n', 'K'), null);
  assert.strictEqual(parseDotenv('K=old\nK=new\n', 'K'), 'new');
});

test('run end to end against a fake agy replaying a fixture', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'),
    `#!/bin/sh\necho "$@" > "${tmp}/args"\ncat > "${tmp}/stdin"\ncat "${path.join(__dirname, 'fixtures', 'tool-error.ndjson')}"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, GEMINI_CACHE_DIR: path.join(tmp, 'cache') };
  const cwd = fs.mkdtempSync(path.join(tmp, 'work-'));
  const run = (...a) => spawnSync(process.execPath, [RELAY, 'run', ...a], { cwd, env, encoding: 'utf8' });

  const r1 = run('--model', 'gemini-4-carbon-low', 'list it');
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /\[tool\] run_command/);
  assert.match(r1.stdout, /conversation: 00000000-0000-0000-0000-000000000001\n$/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'stdin'), 'utf8')),
    { event: 'user', message: { content: [{ type: 'text', text: 'list it' }] } });
  assert.ok(!fs.readFileSync(path.join(tmp, 'args'), 'utf8').includes('--conversation'));

  run('again');
  assert.match(fs.readFileSync(path.join(tmp, 'args'), 'utf8'), /--conversation 00000000-0000-0000-0000-000000000001/);
  run('--new', 'fresh');
  assert.ok(!fs.readFileSync(path.join(tmp, 'args'), 'utf8').includes('--conversation'));

  const r4 = spawnSync(process.execPath, [RELAY, 'run'], { cwd, env, encoding: 'utf8', input: 'from stdin' });
  assert.strictEqual(r4.status, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'stdin'), 'utf8')).message.content[0].text, 'from stdin');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('run keeps multibyte characters that arrive split across chunks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'), `#!/usr/bin/env node
const b = Buffer.from(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'caf\u00e9' } }) + '\\n'
  + JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\\n');
const cut = b.indexOf(0xc3) + 1;
process.stdout.write(b.subarray(0, cut));
setTimeout(() => process.stdout.write(b.subarray(cut)), 100);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, GEMINI_CACHE_DIR: path.join(tmp, 'cache') };
  const r = spawnSync(process.execPath, [RELAY, 'run', 'x'], { cwd: tmp, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'caf\u00e9\n');
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeAgy(tmp, models) {
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'), `#!/bin/sh\nprintf '%s\\n' ${models}\n`, { mode: 0o755 });
}
const LOGIN = JSON.stringify({ token: { refresh_token: 'r' } });
const b64 = (j) => Buffer.from(j).toString('base64');
function setupRun(models, { env: extra = {}, dotenv } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  fakeAgy(tmp, models);
  if (dotenv) fs.writeFileSync(path.join(tmp, '.env'), dotenv);
  const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` };
  delete env.GEMINI_AGY_TOKEN_B64; delete env.ARGON_AGY_TOKEN_B64;
  const r = spawnSync(process.execPath, [RELAY, 'setup'], { cwd: tmp, env: { ...env, ...extra }, encoding: 'utf8' });
  const tokenFile = path.join(tmp, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : null;
  fs.rmSync(tmp, { recursive: true, force: true });
  return { r, token };
}
const NEON = fs.readFileSync(path.join(__dirname, '..', 'acp', 'test', 'fixtures', 'models.txt'), 'utf8').trim().split('\n').map((l) => `'${l}'`).join(' ');

test('setup reads GEMINI_AGY_TOKEN_B64, falls back to ARGON_AGY_TOKEN_B64, and counts neon models', () => {
  for (const key of ['GEMINI_AGY_TOKEN_B64', 'ARGON_AGY_TOKEN_B64']) {
    const { r, token } = setupRun(NEON, { env: { [key]: b64(LOGIN) } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`login: from ${key}`));
    assert.match(r.stdout, /\(4 neon models\)/);
    assert.strictEqual(token, LOGIN);
  }
});

test('setup: the Gemini key wins over the legacy key across env and .env', () => {
  const stale = JSON.stringify({ token: { refresh_token: 'stale' } });
  const { r, token } = setupRun(NEON, { env: { ARGON_AGY_TOKEN_B64: b64(stale) }, dotenv: `GEMINI_AGY_TOKEN_B64=${b64(LOGIN)}\n` });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(token, LOGIN);
});

test('setup: a malformed token names the key that was used', () => {
  for (const key of ['GEMINI_AGY_TOKEN_B64', 'ARGON_AGY_TOKEN_B64']) {
    const { r } = setupRun(NEON, { env: { [key]: 'bm90IGEgbG9naW4=' } });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`${key} is set but is not base64`));
  }
});

test('setup: Orchestrator (Neon) or Carbon alone is not enough, gemini-4-neon-high is required', () => {
  const { r } = setupRun("'gemini-pro-orchestrator-neon\tOrchestrator (Neon)' 'gemini-4-carbon-high\tGemini 4 Carbon (High)' 'gemini-4-neon-low\tGemini 4 Neon (Low)'", { env: { GEMINI_AGY_TOKEN_B64: b64(LOGIN) } });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /does not list gemini-4-neon-high/);
});

test('a conversation saved in the old ~/.cache/argon cache still resumes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'), `#!/bin/sh\necho "$@" > "${tmp}/args"\ncat >/dev/null\ncat "${path.join(__dirname, 'fixtures', 'tool-error.ndjson')}"\n`, { mode: 0o755 });
  const cwd = fs.mkdtempSync(path.join(tmp, 'work-'));
  fs.mkdirSync(path.join(tmp, '.cache', 'argon'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.cache', 'argon', 'conversations.json'), JSON.stringify({ [fs.realpathSync(cwd)]: 'old-conv', '/unrelated/dir': 'other-conv' }));
  const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` };
  delete env.GEMINI_CACHE_DIR; delete env.ARGON_CACHE_DIR;
  const r = spawnSync(SHIM, ['run', 'hi'], { cwd, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(tmp, 'args'), 'utf8'), /--conversation old-conv/);
  // the new save does not copy legacy entries; an explicit cache dir ignores the legacy cache
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, '.cache', 'gemini-relay', 'conversations.json'), 'utf8'))), [fs.realpathSync(cwd)]);
  fs.rmSync(path.join(tmp, '.cache', 'gemini-relay'), { recursive: true });
  spawnSync(RELAY, ['run', 'hi'], { cwd, env: { ...env, GEMINI_CACHE_DIR: path.join(tmp, 'other') }, encoding: 'utf8' });
  assert.ok(!fs.readFileSync(path.join(tmp, 'args'), 'utf8').includes('--conversation old-conv'));
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, 'other', 'conversations.json'), 'utf8'))), [fs.realpathSync(cwd)]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('export-token writes GEMINI_AGY_TOKEN_B64', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  const json = JSON.stringify({ token: { refresh_token: 'r' } });
  fs.mkdirSync(path.join(tmp, '.gemini', 'antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), json);
  const r = spawnSync(process.execPath, [RELAY, 'export-token'], { cwd: tmp, env: { ...process.env, HOME: tmp }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, `GEMINI_AGY_TOKEN_B64=${Buffer.from(json).toString('base64')}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cli/argon shim delegates to gemini-relay (usage and a run with the neon default)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'), `#!/bin/sh\necho "$@" > "${tmp}/args"\ncat >/dev/null\ncat "${path.join(__dirname, 'fixtures', 'tool-error.ndjson')}"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, GEMINI_CACHE_DIR: path.join(tmp, 'cache') };
  const viaNode = spawnSync(process.execPath, [SHIM, '--help'], { env, encoding: 'utf8' });
  assert.strictEqual(viaNode.status, 0, viaNode.stderr);
  assert.match(viaNode.stdout, /usage: gemini-relay <command>/);
  const help = spawnSync(SHIM, ['--help'], { env, encoding: 'utf8' });
  assert.strictEqual(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: gemini-relay <command>/);
  assert.match(help.stdout, /default model: gemini-4-neon-high/);
  const r = spawnSync(SHIM, ['run', 'hi'], { cwd: tmp, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(tmp, 'args'), 'utf8'), /--model gemini-4-neon-high/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('setup: an agy that cannot execute reports the launch error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'), '#!/nonexistent/interp\n', { mode: 0o755 });
  const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, GEMINI_AGY_TOKEN_B64: b64(LOGIN) };
  const r = spawnSync(process.execPath, [RELAY, 'setup'], { cwd: tmp, env, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /could not run agy models/);
  assert.match(r.stderr, /ENOENT|EACCES|spawn/);
  assert.ok(!/does not list gemini-4-neon-high/.test(r.stderr), r.stderr);
  assert.ok(!/undefined|TypeError/.test(r.stderr), r.stderr);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cli/argon shim forwards SIGTERM to agy', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  const pidFile = path.join(tmp, 'agy.pid');
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'), `#!/usr/bin/env node
process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'got-term'))}, '1'); process.exit(0); });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, GEMINI_CACHE_DIR: path.join(tmp, 'cache') };
  const child = require('child_process').spawn(SHIM, ['run', 'hi'], { cwd: tmp, env, stdio: 'ignore' });
  let exited = child.exitCode !== null || child.signalCode !== null;
  const closed = new Promise((res) => child.on('close', () => { exited = true; res(); }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const agyPid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8')); } catch { return 0; } };
  let deadlineTimer;
  try {
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(50);
    assert.ok(fs.existsSync(pidFile), 'agy started');
    child.kill('SIGTERM');
    const deadline = await Promise.race([closed.then(() => false), new Promise((r) => { deadlineTimer = setTimeout(() => r(true), 5000); })]);
    assert.ok(!deadline, 'shim exited within 5s of SIGTERM');
    assert.ok(fs.existsSync(path.join(tmp, 'got-term')), 'agy received SIGTERM through the shim');
  } finally {
    clearTimeout(deadlineTimer);
    const pid = agyPid();
    if (!exited) child.kill('SIGTERM');
    if (pid && alive(pid)) process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 20 && (!exited || (pid && alive(pid))); i++) await sleep(100);
    if (!exited) { child.kill('SIGKILL'); await closed; }
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('require("../cli/argon") returns the helpers without running the CLI', () => {
  const r = spawnSync(process.execPath, ['-e', `const m = require(${JSON.stringify(SHIM)}); console.log(Object.keys(m).sort().join(','), typeof m.parseArgs, process.argv.length)`, 'x'], { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'agyArgs,normalizeToken,parseArgs,parseDotenv,render function 2');
  assert.strictEqual(r.stderr, '');
  const m = require('../cli/argon');
  assert.strictEqual(m.parseArgs, parseArgs);
  assert.strictEqual(m.render, render);
});
