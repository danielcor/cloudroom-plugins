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
  assert.strictEqual(parseArgs(['run']).opts.model, 'gemini-4-carbon-high');
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
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'),
    `#!/bin/sh\nif [ "$1" = models ]; then printf '%s\\n' ${models}; exit 0; fi\ncat >/dev/null\ncat "${path.join(__dirname, 'fixtures', 'tool-error.ndjson')}"\n`, { mode: 0o755 });
}

test('setup reads GEMINI_AGY_TOKEN_B64, falls back to ARGON_AGY_TOKEN_B64, and checks carbon models', () => {
  const json = JSON.stringify({ token: { refresh_token: 'r' } });
  const b64 = Buffer.from(json).toString('base64');
  for (const key of ['GEMINI_AGY_TOKEN_B64', 'ARGON_AGY_TOKEN_B64']) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
    fakeAgy(tmp, "'Gemini 4 Carbon (High)' 'Gemini 4 Carbon (Low)'");
    const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, [key]: b64 };
    delete env[key === 'GEMINI_AGY_TOKEN_B64' ? 'ARGON_AGY_TOKEN_B64' : 'GEMINI_AGY_TOKEN_B64'];
    const r = spawnSync(process.execPath, [RELAY, 'setup'], { cwd: tmp, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`login: from ${'GEMINI_AGY_TOKEN_B64'}`));
    assert.match(r.stdout, /\(2 carbon models\)/);
    assert.strictEqual(fs.readFileSync(path.join(tmp, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'), json);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('cli/argon shim delegates to gemini-relay (usage and a run with the carbon default)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-relay-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'agy'), `#!/bin/sh\necho "$@" > "${tmp}/args"\ncat >/dev/null\ncat "${path.join(__dirname, 'fixtures', 'tool-error.ndjson')}"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: tmp, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, GEMINI_CACHE_DIR: path.join(tmp, 'cache') };
  const help = spawnSync(SHIM, ['--help'], { env, encoding: 'utf8' });
  assert.strictEqual(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: gemini-relay <command>/);
  assert.match(help.stdout, /default model: gemini-4-carbon-high/);
  const r = spawnSync(SHIM, ['run', 'hi'], { cwd: tmp, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(tmp, 'args'), 'utf8'), /--model gemini-4-carbon-high/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
