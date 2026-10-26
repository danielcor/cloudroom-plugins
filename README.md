# cloudroom-argon

Gemini 4 Argon (Google Antigravity, `agy`) for Cloudroom.

- [`acp/`](acp/): **agy-acp**, an Agent Client Protocol agent that wraps the agy CLI's headless
  stream-json mode. Works with any ACP client. Its README has the ACP compliance note.
- [`plugin/`](plugin/): **provider-agy**, a Cloudroom plugin that adds the "Antigravity" provider
  (id `agy`) to local threads. It runs agy-acp through the plugin SDK's ACP bridge.

agy keeps its own Google login on each machine. Nothing here reads, copies or logs credentials.

## Install

Each machine that runs Antigravity threads needs agy (signed in) and agy-acp. The Cloudroom
server needs the plugin once. Today aipc-ubuntu runs the server, and the Mac and
aliengaming-wsl-debian join it as machines, so the plugin goes on aipc only.

### 1. agy and agy-acp (on every machine: aipc, Mac, WSL)

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash   # skip if `agy --version` works
agy models                                                   # must list gemini-4-argon-*; if not, run `agy` and sign in
mkdir -p ~/src && git clone https://github.com/danielcor/cloudroom-argon ~/src/cloudroom-argon
npm install -g ~/src/cloudroom-argon/acp                     # links agy-acp into npm's global bin; keep the clone
agy-acp --version
```

Cloudroom's daemon must find `agy-acp` on its PATH (on aipc, `~/.npm-global/bin` is on it). If
`which agy-acp` is not on the daemon's PATH, link it into one that is, for example
`ln -s "$(which agy-acp)" ~/.local/bin/agy-acp`. agy-acp itself finds agy on PATH or in
`~/.local/bin`.

### 2. The plugin (on the Cloudroom server, aipc)

```sh
cd ~/src/cloudroom-argon/plugin && npm ci
room-cli plugin build .
room-cli plugin install path:$HOME/src/cloudroom-argon/plugin --yes
room-cli plugin list | grep -A1 provider-agy       # provider-agy@0.1.0  running
room-cli provider models agy --machine aipc-ubuntu # Gemini 4 Argon High (default), Medium, Low
```

`room-cli` here is the desktop app's CLI. On aipc it lives inside the mounted AppImage:
`/tmp/.mount_Cloudr*/resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/room-cli`.

A machine without agy-acp shows only "Agent default" under `room-cli provider models agy --machine <name>`.
Install step 1 there, then run `room-cli provider models agy --machine <name> --restart`.

## Start an Argon thread

1. In Cloudroom, start a new thread on a project and pick the machine (aipc-ubuntu, mac or
   aliengaming-wsl-debian).
2. Pick the **Antigravity** provider and a model: Gemini 4 Argon High (default), Medium or Low.
3. Pick the permission mode. **Accept edits** lets agy edit files but auto-denies shell commands
   (headless agy cannot ask; the reply names what it denied). **Full** runs agy with
   `--dangerously-skip-permissions`.
4. Optional: the reasoning level maps to agy `--effort`.

Threads resume after a restart: agy-acp keeps each thread's agy conversation id and restarts agy with `--conversation`.

## Develop

```sh
cd acp && npm test                          # agy-acp unit tests (fake agy replaying recorded transcripts)
cd plugin && npm ci && npx tsc --noEmit && npx vitest run   # registration + SDK bridge conformance
AGY_SMOKE=1 npx vitest run test/live-agy.smoke.test.ts      # live: two gemini-4-argon-low turns through the bridge
```

## Notes

- Cloud threads cannot use this plugin: the cloud core has a fixed harness list. agy-acp is the
  piece a cloud harness could launch, as it speaks the same ACP methods the cloud core already uses.
- Google also ships an official ACP server, `antigravity-acp` (`agy_acp_server`, listed in the
  ACP registry). It needs its own Google sign-in per
  machine (browser OAuth) and is a ~0.9 GB download. agy-acp reuses the agy CLI login instead.
