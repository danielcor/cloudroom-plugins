// Replays a recorded agy stream-json transcript: prints the init line at start,
// then the next recorded turn (through its "result" line, cycling) per stdin user message.
// A message containing "hang" gets no reply until SIGINT.
// FAKE_AGY_FIXTURE: transcript path. FAKE_AGY_ON_SIGINT: lines printed on SIGINT before exit 1.
// FAKE_AGY_ARGS_LOG: each run appends its argv as one JSON line. FAKE_AGY_PID_LOG: each run appends its pid.
// FAKE_AGY_INIT_DELAY_MS: delay before the init line. FAKE_AGY_IGNORE_SIGTERM=1: survive SIGTERM and stdin EOF.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write(readFileSync(new URL("fixtures/models.txt", import.meta.url), "utf8"));
  process.exit(0);
}
if (process.env.FAKE_AGY_ARGS_LOG) appendFileSync(process.env.FAKE_AGY_ARGS_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000); // a hung agy: stays up after stdin closes
}
if (process.env.FAKE_AGY_PID_LOG) appendFileSync(process.env.FAKE_AGY_PID_LOG, `${process.pid}\n`);
const lines = readFileSync(process.env.FAKE_AGY_FIXTURE, "utf8").split("\n").filter(Boolean);
const init = JSON.parse(lines[0]);
const conv = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : init.conversation_id;
const known = conv !== "missing";
if (!known) process.stderr.write(`warning: conversation "${conv}" not found\n`);
init.conversation_id = known ? conv : "99999999-0000-0000-0000-000000000000";
setTimeout(() => process.stdout.write(`${JSON.stringify(init)}\n`), Number(process.env.FAKE_AGY_INIT_DELAY_MS ?? 0));

const turns = [[]];
for (const line of lines.slice(1)) {
  turns.at(-1).push(line);
  if (JSON.parse(line).event === "result") turns.push([]);
}
const recorded = turns.filter((t) => t.length > 0);
let next = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.includes("hang")) return;
  for (const out of recorded[next++ % recorded.length] ?? []) process.stdout.write(`${out}\n`);
});
process.on("SIGINT", () => {
  if (process.env.FAKE_AGY_ON_SIGINT) process.stdout.write(readFileSync(process.env.FAKE_AGY_ON_SIGINT, "utf8"));
  process.exit(1);
});
