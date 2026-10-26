#!/usr/bin/env node
// Test double for `muse-acp --list-models --first ID`: muse-acp's own formatter over
// Muse 1.4.13's catalog in the order and with the default flag Muse returned.
import { formatModels } from "../../muse-acp/muse-acp.mjs";

const catalog = [
  { id: "muse-wonder-1.0", name: "muse-wonder-1.0" },
  { id: "muse-wonder-1.0-contributor", name: "muse-wonder-1.0-contributor", isDefault: true },
  { id: "muse-wonder-full-1.0-contributor", name: "muse-wonder-1.0-contributor" },
  { id: "muse-wonder-full-1.0", name: "muse-wonder-full-1.0" },
  { id: "muse-spark-1.3", name: "muse-spark-1.3" },
  { id: "muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor" },
  { id: "muse-spark-1.2", name: "muse-spark-1.2" },
  { id: "muse-spark-1.2-contributor", name: "muse-spark-1.2-contributor" },
];
const argv = process.argv.slice(2);
if (!argv.includes("--list-models")) process.exit(2);
process.stdout.write(formatModels(catalog, argv[argv.indexOf("--first") + 1]));
