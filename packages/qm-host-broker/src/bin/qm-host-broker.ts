#!/usr/bin/env -S node --
import { main } from "../cli.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPhaseFFakeArtifactProducer,
  resolveInstalledBrowserSkillExecutable,
  resolveRelayUrlFromEnv,
} from "../index.ts";
import { probeInstalledBrowserRuntime } from "../runtime-probe.ts";
import { HOST_BROKER_COMPANION_PORT } from "../companion-control.ts";

const controller = new AbortController();
const onSignal = (): void => controller.abort();

process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  const installRoot = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
  const runtime = await probeInstalledBrowserRuntime({ installRoot, env: process.env });
  await main(process.argv.slice(2), {
    dataDir: process.env.QM_HOST_BROKER_DATA_DIR ?? ".qm-host-broker",
    stdout: process.stdout,
    stderr: process.stderr,
    signal: controller.signal,
    brokerInstanceId: process.env.QM_HOST_BROKER_INSTANCE_ID,
    companionPort: HOST_BROKER_COMPANION_PORT,
    deviceId: process.env.QM_HOST_BROKER_DEVICE_ID,
    runtime,
    browserSkillExecutable: resolveInstalledBrowserSkillExecutable({ env: process.env, installRoot }),
    resolveRelayUrl: (qmUrl) => resolveRelayUrlFromEnv(qmUrl, process.env),
    ...(process.env.QM_HOST_BROKER_PHASE_F_FAKE_ARTIFACT === "1"
      ? { artifactProducer: createPhaseFFakeArtifactProducer() }
      : {}),
  });
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
