#!/usr/bin/env -S node --
import { main } from "../cli.ts";
import { resolveRelayUrlFromEnv } from "../index.ts";

const controller = new AbortController();
const onSignal = (): void => controller.abort();

process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  await main(process.argv.slice(2), {
    dataDir: process.env.QM_HOST_BROKER_DATA_DIR ?? ".qm-host-broker",
    stdout: process.stdout,
    stderr: process.stderr,
    signal: controller.signal,
    resolveRelayUrl: (qmUrl) => resolveRelayUrlFromEnv(qmUrl, process.env),
  });
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
