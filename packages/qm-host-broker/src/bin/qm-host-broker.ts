#!/usr/bin/env -S node --
import { main } from "../cli.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstalledBrowserSkillExecutable, resolveRelayUrlFromEnv } from "../index.ts";

const controller = new AbortController();
const onSignal = (): void => controller.abort();

process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  const installRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  await main(process.argv.slice(2), {
    dataDir: process.env.QM_HOST_BROKER_DATA_DIR ?? ".qm-host-broker",
    stdout: process.stdout,
    stderr: process.stderr,
    signal: controller.signal,
    deviceId: process.env.QM_HOST_BROKER_DEVICE_ID,
    browserSkillExecutable: resolveInstalledBrowserSkillExecutable({ env: process.env, installRoot }),
    resolveRelayUrl: (qmUrl) => resolveRelayUrlFromEnv(qmUrl, process.env),
  });
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
