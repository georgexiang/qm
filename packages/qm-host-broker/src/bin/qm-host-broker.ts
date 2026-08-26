#!/usr/bin/env -S node --
import { main } from "../cli.ts";

await main(process.argv.slice(2), {
  dataDir: process.env.QM_HOST_BROKER_DATA_DIR ?? ".qm-host-broker",
  stdout: process.stdout,
  stderr: process.stderr,
});
