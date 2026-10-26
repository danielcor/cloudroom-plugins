// Replays a recorded agy stream-json transcript: prints the init line at start,
// then one recorded turn (through its "result" line) per stdin user message.
// FAKE_AGY_FIXTURE: transcript path. FAKE_AGY_ON_SIGINT: lines printed on SIGINT before exit 1.
// FAKE_AGY_ARGS_LOG: each run appends its argv as one JSON line.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (process.env.FAKE_AGY_ARGS_LOG) appendFileSync(process.env.FAKE_AGY_ARGS_LOG, `${JSON.stringify(args)}\n`);
const lines = readFileSync(process.env.FAKE_AGY_FIXTURE, "utf8").split("\n").filter(Boolean);
const init = JSON.parse(lines[0]);
const conv = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : init.conversation_id;
const known = conv !== "missing";
if (!known) process.stderr.write(`warning: conversation "${conv}" not found\n`);
init.conversation_id = known ? conv : "99999999-0000-0000-0000-000000000000";
process.stdout.write(`${JSON.stringify(init)}\n`);

const turns = [[]];
for (const line of lines.slice(1)) {
  turns.at(-1).push(line);
  if (JSON.parse(line).event === "result") turns.push([]);
}
let next = 0;
createInterface({ input: process.stdin }).on("line", () => {
  for (const line of turns[next++] ?? []) process.stdout.write(`${line}\n`);
});
process.on("SIGINT", () => {
  if (process.env.FAKE_AGY_ON_SIGINT) process.stdout.write(readFileSync(process.env.FAKE_AGY_ON_SIGINT, "utf8"));
  process.exit(1);
});
