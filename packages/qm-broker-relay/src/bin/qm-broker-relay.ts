#!/usr/bin/env -S node --
import { runDesktopBrowserRelayProcess } from "../process.ts";

const runtime = await runDesktopBrowserRelayProcess(process.env);
const address = runtime.server.server.address();
const port = typeof address === "object" && address ? address.port : runtime.config.port;
console.log(`[qm-broker-relay] listening on ${runtime.config.host}:${port} path=${runtime.config.wssPath}`);
