import { DESKTOP_BROWSER_PROTOCOL_VERSION, type DesktopBrowserMessage } from "./index.ts";

export const phaseFContractFixtures: readonly DesktopBrowserMessage[] = [
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "core.authority",
    payload: {
      requestId: "request-1",
      audience: "qm-desktop-broker-relay",
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "relay.invoke",
    payload: {
      dispatchId: "dispatch-1",
      operationId: "operation-1",
      requestHash: "sha256:request-1",
      argv: ["--json", "session", "start"],
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      operationId: "operation-1",
      outcome: "completed",
      resultHash: "sha256:result-1",
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "companion.status",
    payload: {
      brokerStatus: "ready",
      browserSkillStatus: "ready",
      currentTaskPresent: true,
    },
  },
];
