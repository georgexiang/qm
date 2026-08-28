const endpoint = "http://127.0.0.1:32145";
const brokerStatus = document.querySelector("#broker-status");
const browserStatus = document.querySelector("#browser-status");
const brokerSignal = document.querySelector("#broker-signal");
const browserSignal = document.querySelector("#browser-signal");
const deviceSignal = document.querySelector("#device-signal");
const deviceStatus = document.querySelector("#device-status");
const operation = document.querySelector("#operation");
const operationCategory = document.querySelector("#operation-category");
const elapsed = document.querySelector("#elapsed");
const idle = document.querySelector("#idle");
const stopButton = document.querySelector("#stop");
const error = document.querySelector("#error");
let stopNonce = null;
let polling = false;

function requestId() {
  return crypto.randomUUID();
}

function formatElapsed(value) {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function categoryLabel(value) {
  return {
    session_start: "Starting session",
    browser_effect: "Browser action",
    observation: "Reading page",
    session_cleanup: "Cleaning up session",
  }[value] ?? "In progress";
}

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch(`${endpoint}/v1/status`, {
      cache: "no-store",
      credentials: "omit",
      headers: {
        "x-qm-request-id": requestId(),
        "x-qm-readiness-nonce": crypto.randomUUID(),
      },
    });
    if (!response.ok) throw new Error("Host Broker control is unavailable");
    const status = await response.json();
    brokerStatus.textContent = status.brokerStatus === "ready" ? "Ready" : "Offline";
    browserStatus.textContent = status.browserSkillStatus === "ready" ? "Ready" : "Offline";
    brokerSignal.classList.toggle("ready", status.brokerStatus === "ready");
    browserSignal.classList.toggle("ready", status.browserSkillStatus === "ready");
    const deviceReady = status.deviceStatus !== "needs_local_reconciliation";
    deviceStatus.textContent = deviceReady ? "Ready" : "Inspect locally";
    deviceSignal.classList.toggle("ready", deviceReady);
    operation.hidden = !status.currentTaskPresent;
    idle.hidden = status.currentTaskPresent;
    stopNonce = status.stopNonce ?? null;
    if (status.currentTaskPresent) {
      operationCategory.textContent = categoryLabel(status.operationCategory);
      elapsed.textContent = formatElapsed(status.elapsedMs ?? 0);
    }
    showError("");
  } catch (_cause) {
    brokerStatus.textContent = "Offline";
    browserStatus.textContent = "Unknown";
    brokerSignal.classList.remove("ready");
    browserSignal.classList.remove("ready");
    operation.hidden = true;
    idle.hidden = false;
    stopNonce = null;
    showError("Host Broker control is unavailable");
  } finally {
    polling = false;
  }
}

stopButton.addEventListener("click", async () => {
  if (!stopNonce) return;
  stopButton.disabled = true;
  try {
    const response = await fetch(`${endpoint}/v1/stop`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        "x-qm-request-id": requestId(),
      },
      body: JSON.stringify({ stopNonce }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error === "task_changed" ? "The current task changed. Refresh and try again." : "Stop failed");
    }
    stopNonce = null;
    await refresh();
  } catch (cause) {
    showError(cause instanceof Error ? cause.message : "Stop failed");
  } finally {
    stopButton.disabled = false;
  }
});

void refresh();
setInterval(refresh, 1000);
