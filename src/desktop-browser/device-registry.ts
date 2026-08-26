import { createHash, createPublicKey, verify } from "node:crypto";
import {
  DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION,
  computeDesktopBrowserPublicDeviceFingerprint,
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  encodeDesktopBrowserRegistrationConfirmationVerificationBytes,
  projectDesktopBrowserPublicIdentity,
  parseDesktopBrowserRegistrationConfirmationEnvelope,
  type DesktopBrowserRelayConnectionProjection,
  type DesktopBrowserRelayRegistryBinding,
  type DesktopBrowserOnlineDeviceProjection,
  type DesktopBrowserPublicIdentity,
  type DesktopBrowserRegistrationConfirmationEnvelope,
  type DesktopBrowserRegistrationReservationTuple,
} from "qm-desktop-browser-contracts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { constantTimeEqual } from "../util/crypto.ts";

export interface DesktopBrowserSharedProfileProjection {
  sharedProfileMode: "deployment_shared_browser_principal";
  device: DesktopBrowserOnlineDeviceProjection;
}

export interface DesktopBrowserChallengeBinding {
  registrationId: string;
  devicePublicKey: string;
  brokerInstanceId: string;
  browserInstanceId: string;
  connectionEpoch: number;
  expiresAt: string;
}

export interface DesktopBrowserRegistrationRecord {
  registrationId: string;
  waitingTaskId: string;
  actorId: string;
  projectId: string;
  membershipEpoch: number;
  authorityId: string;
  authorityExpiresAt: number;
  status: "pending" | "online" | "offline";
  registrationTuple: DesktopBrowserRegistrationReservationTuple;
  publicIdentity: DesktopBrowserPublicIdentity;
  confirmationFingerprint: string;
  publicDeviceFingerprint: string;
  operatingSystem: string;
  browserRuntimeStatus: "ready" | "offline";
  pendingConfirmation:
    | {
        browserRuntimeStatus: "ready" | "offline";
        envelope: DesktopBrowserRegistrationConfirmationEnvelope;
        receivedAt: number;
      }
    | null;
  lastSeenAt: string;
  createdAt: number;
  updatedAt: number;
}

export interface DesktopBrowserTaskRegistrationProjection {
  registrationId: string;
  confirmationFingerprint: string;
  expiresAt: string;
  status: "waiting_for_local_confirmation" | "ready_to_confirm" | "confirmed";
}

export interface DesktopBrowserTaskClaimRecord {
  waitingTaskId: string;
  registrationId: string;
  projectId: string;
  actorId: string;
  membershipEpoch: number;
  authorityId: string;
  authorityExpiresAt: number;
  brokerInstanceId: string;
  browserInstanceId: string;
  connectionEpoch: number;
  claimedAt: number;
}

export interface DesktopBrowserProjectHeadRecord {
  projectId: string;
  registrationId: string;
  updatedAt: number;
}

interface DesktopBrowserDeviceRegistryState {
  registrations: Record<string, DesktopBrowserRegistrationRecord>;
  taskClaims: Record<string, DesktopBrowserTaskClaimRecord>;
  projectHeads: Record<string, DesktopBrowserProjectHeadRecord>;
  relayConnections: Record<string, DesktopBrowserRelayConnectionProjection>;
}

export interface DesktopBrowserDeviceRegistryBacking {
  state: DurableMap<DesktopBrowserDeviceRegistryState>;
}

export interface DesktopBrowserReservationView {
  registrationTuple: DesktopBrowserRegistrationReservationTuple;
  publicIdentity: DesktopBrowserPublicIdentity;
  confirmationFingerprint: string;
  publicDeviceFingerprint: string;
  verificationBytes: Uint8Array<ArrayBuffer>;
  verificationBytesBase64: string;
}

type DesktopBrowserRegistryRefusal = { status: "refused"; reason: string };

type DesktopBrowserReservationResult =
  { status: "ok"; reservation: DesktopBrowserReservationView } | DesktopBrowserRegistryRefusal;

type DesktopBrowserConfirmationResult =
  { status: "ok"; device: DesktopBrowserSharedProfileProjection } | DesktopBrowserRegistryRefusal;

type DesktopBrowserOfflineResult =
  { status: "ok"; device: DesktopBrowserSharedProfileProjection } | DesktopBrowserRegistryRefusal;

export interface DesktopBrowserDeviceRegistry {
  reserve(input: {
    waitingTaskId: string;
    actorId: string;
    projectId: string;
    membershipEpoch: number;
    authorityId: string;
    authorityExpiresAt: number;
    devicePublicKey: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
    operatingSystem: string;
  }): Promise<DesktopBrowserReservationResult>;
  challengeBinding(registrationId: string): Promise<DesktopBrowserChallengeBinding | null>;
  get(registrationId: string): Promise<DesktopBrowserRegistrationRecord | null>;
  taskRegistration(waitingTaskId: string): Promise<DesktopBrowserTaskRegistrationProjection | null>;
  stagedConfirmation(registrationId: string): Promise<
    | {
        browserRuntimeStatus: "ready" | "offline";
        envelope: DesktopBrowserRegistrationConfirmationEnvelope;
      }
    | null
  >;
  stageConfirmation(input: {
    registrationId: string;
    browserRuntimeStatus: "ready" | "offline";
    envelope: DesktopBrowserRegistrationConfirmationEnvelope;
  }): Promise<{ status: "ok"; registration: DesktopBrowserTaskRegistrationProjection } | DesktopBrowserRegistryRefusal>;
  confirm(input: {
    registrationId: string;
    authorityId: string;
    browserRuntimeStatus: "ready" | "offline";
    envelope: DesktopBrowserRegistrationConfirmationEnvelope;
  }): Promise<DesktopBrowserConfirmationResult>;
  markOffline(input: {
    registrationId: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
  }): Promise<DesktopBrowserOfflineResult>;
  invalidate(registrationId: string): Promise<void>;
  projectProjection(projectId: string): Promise<DesktopBrowserSharedProfileProjection | null>;
  relayBinding(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
  }): Promise<DesktopBrowserRelayRegistryBinding | null>;
  publishRelayConnection(projection: DesktopBrowserRelayConnectionProjection): Promise<void>;
  clearRelayConnection(connectionId: string): Promise<void>;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export type DesktopBrowserConfirmMutationPoint =
  | "afterTaskClaimWrite"
  | "afterCurrentRegistrationInstall"
  | "afterProjectHeadInstall"
  | "afterSiblingReservationInvalidate";

const REGISTRY_STATE_ID = "desktop-browser-device-registry";

function emptyRegistryState(): DesktopBrowserDeviceRegistryState {
  return { registrations: {}, taskClaims: {}, projectHeads: {}, relayConnections: {} };
}

function cloneRegistryState(state: DesktopBrowserDeviceRegistryState): DesktopBrowserDeviceRegistryState {
  return {
    registrations: { ...state.registrations },
    taskClaims: { ...state.taskClaims },
    projectHeads: { ...state.projectHeads },
    relayConnections: { ...state.relayConnections },
  };
}

function relayBindingFromRecord(record: DesktopBrowserRegistrationRecord): DesktopBrowserRelayRegistryBinding | null {
  if (record.status === "pending") {
    return {
      registrationId: record.registrationId,
      registrationState: "pending",
      devicePublicKey: record.registrationTuple.devicePublicKey,
      brokerInstanceId: record.registrationTuple.brokerInstanceId,
      browserInstanceId: record.registrationTuple.browserInstanceId,
      connectionEpoch: record.registrationTuple.connectionEpoch,
    };
  }
  if (record.status !== "online") return null;
  return {
    registrationId: record.registrationId,
    registrationState: "registered",
    devicePublicKey: record.registrationTuple.devicePublicKey,
    brokerInstanceId: record.registrationTuple.brokerInstanceId,
    browserInstanceId: record.registrationTuple.browserInstanceId,
    connectionEpoch: record.registrationTuple.connectionEpoch,
  };
}

function compareRelayBindings(
  left: DesktopBrowserRelayRegistryBinding,
  right: DesktopBrowserRelayRegistryBinding,
): number {
  if (left.connectionEpoch !== right.connectionEpoch) return right.connectionEpoch - left.connectionEpoch;
  if (left.registrationState !== right.registrationState) return left.registrationState === "registered" ? -1 : 1;
  return left.registrationId.localeCompare(right.registrationId);
}

function offlineRecord(record: DesktopBrowserRegistrationRecord, at: number): DesktopBrowserRegistrationRecord {
  return {
    ...record,
    status: "offline",
    browserRuntimeStatus: "offline",
    updatedAt: at,
    lastSeenAt: iso(at),
  };
}

function toProjection(record: DesktopBrowserRegistrationRecord): DesktopBrowserSharedProfileProjection {
  return {
    sharedProfileMode: "deployment_shared_browser_principal",
    device: {
      publicDeviceFingerprint: record.publicDeviceFingerprint,
      browserInstanceId: record.registrationTuple.browserInstanceId,
      operatingSystem: record.operatingSystem,
      status: record.status === "online" ? "online" : "offline",
      browserRuntimeStatus: record.status === "online" ? record.browserRuntimeStatus : "offline",
      lastSeenAt: record.lastSeenAt,
    },
  };
}

function taskRegistrationProjection(record: DesktopBrowserRegistrationRecord): DesktopBrowserTaskRegistrationProjection {
  let status: DesktopBrowserTaskRegistrationProjection["status"] = "waiting_for_local_confirmation";
  if (record.status === "online") status = "confirmed";
  else if (record.pendingConfirmation) status = "ready_to_confirm";
  return {
    registrationId: record.registrationId,
    confirmationFingerprint: record.confirmationFingerprint,
    expiresAt: record.registrationTuple.expiresAt,
    status,
  };
}

function decodeDevicePublicKey(devicePublicKey: string) {
  if (!devicePublicKey.startsWith("ed25519:")) throw new Error("devicePublicKey must use ed25519:<base64-spki-der>");
  return createPublicKey({
    key: Buffer.from(devicePublicKey.slice("ed25519:".length), "base64"),
    format: "der",
    type: "spki",
  });
}

function sameRegistrationTuple(
  left: DesktopBrowserRegistrationReservationTuple,
  right: DesktopBrowserRegistrationReservationTuple,
): boolean {
  return constantTimeEqual(
    Buffer.from(JSON.stringify(left)).toString("base64"),
    Buffer.from(JSON.stringify(right)).toString("base64"),
  );
}

function deterministicRegistrationId(input: {
  waitingTaskId: string;
  actorId: string;
  projectId: string;
  membershipEpoch: number;
  authorityId: string;
  devicePublicKey: string;
  brokerInstanceId: string;
  browserInstanceId: string;
  connectionEpoch: number;
}): string {
  return `reg-${createHash("sha256")
    .update(
      JSON.stringify({
        waitingTaskId: input.waitingTaskId,
        actorId: input.actorId,
        projectId: input.projectId,
        membershipEpoch: input.membershipEpoch,
        authorityId: input.authorityId,
        devicePublicKey: input.devicePublicKey,
        brokerInstanceId: input.brokerInstanceId,
        browserInstanceId: input.browserInstanceId,
        connectionEpoch: input.connectionEpoch,
      }),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

function sameReservationInput(
  record: DesktopBrowserRegistrationRecord,
  input: {
    waitingTaskId: string;
    actorId: string;
    projectId: string;
    membershipEpoch: number;
    authorityId: string;
    authorityExpiresAt: number;
    devicePublicKey: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
    operatingSystem: string;
  },
): boolean {
  return (
    record.waitingTaskId === input.waitingTaskId &&
    record.actorId === input.actorId &&
    record.projectId === input.projectId &&
    record.membershipEpoch === input.membershipEpoch &&
    constantTimeEqual(record.authorityId, input.authorityId) &&
    record.authorityExpiresAt === input.authorityExpiresAt &&
    record.operatingSystem === input.operatingSystem &&
    record.registrationTuple.devicePublicKey === input.devicePublicKey &&
    record.registrationTuple.brokerInstanceId === input.brokerInstanceId &&
    record.registrationTuple.browserInstanceId === input.browserInstanceId &&
    record.registrationTuple.connectionEpoch === input.connectionEpoch
  );
}

function reservationView(record: DesktopBrowserRegistrationRecord): DesktopBrowserReservationView {
  const verificationBytes = encodeDesktopBrowserRegistrationConfirmationVerificationBytes(record.registrationTuple);
  return {
    registrationTuple: record.registrationTuple,
    publicIdentity: record.publicIdentity,
    confirmationFingerprint: record.confirmationFingerprint,
    publicDeviceFingerprint: record.publicDeviceFingerprint,
    verificationBytes,
    verificationBytesBase64: Buffer.from(verificationBytes).toString("base64"),
  };
}

function samePendingConfirmation(
  left:
    | {
        browserRuntimeStatus: "ready" | "offline";
        envelope: DesktopBrowserRegistrationConfirmationEnvelope;
      }
    | null,
  right: {
    browserRuntimeStatus: "ready" | "offline";
    envelope: DesktopBrowserRegistrationConfirmationEnvelope;
  },
): boolean {
  if (!left) return false;
  return (
    left.browserRuntimeStatus === right.browserRuntimeStatus &&
    constantTimeEqual(left.envelope.signature, right.envelope.signature) &&
    sameRegistrationTuple(left.envelope.registrationTuple, right.envelope.registrationTuple) &&
    constantTimeEqual(left.envelope.confirmationFingerprint, right.envelope.confirmationFingerprint)
  );
}

function verifiedEnvelope(
  record: DesktopBrowserRegistrationRecord,
  inputEnvelope: DesktopBrowserRegistrationConfirmationEnvelope,
): DesktopBrowserRegistrationConfirmationEnvelope | null {
  let envelope: DesktopBrowserRegistrationConfirmationEnvelope;
  try {
    envelope = parseDesktopBrowserRegistrationConfirmationEnvelope(inputEnvelope);
  } catch {
    return null;
  }
  if (
    !sameRegistrationTuple(record.registrationTuple, envelope.registrationTuple) ||
    !constantTimeEqual(record.confirmationFingerprint, envelope.confirmationFingerprint) ||
    !constantTimeEqual(record.publicIdentity.devicePublicKey, envelope.publicIdentity.devicePublicKey)
  ) {
    return null;
  }
  try {
    return verify(
      null,
      Buffer.from(encodeDesktopBrowserRegistrationConfirmationVerificationBytes(record.registrationTuple)),
      decodeDevicePublicKey(record.registrationTuple.devicePublicKey),
      Buffer.from(envelope.signature, "base64"),
    )
      ? envelope
      : null;
  } catch {
    return null;
  }
}

export function createDesktopBrowserDeviceRegistry(
  backing: DesktopBrowserDeviceRegistryBacking,
  options: {
    deploymentCanonicalId: string;
    now?: () => number;
    reservationTtlMs?: number;
    onConfirmMutation?: (point: DesktopBrowserConfirmMutationPoint) => void;
  },
): DesktopBrowserDeviceRegistry {
  if (!backing.state.update) throw new Error("desktop browser device registry requires DurableMap.update");
  const update = backing.state.update;
  const now = options.now ?? Date.now;
  const reservationTtlMs = options.reservationTtlMs ?? 5 * 60_000;
  const onConfirmMutation = options.onConfirmMutation;

  async function readState(): Promise<DesktopBrowserDeviceRegistryState> {
    return await backing.state.putIfAbsent(REGISTRY_STATE_ID, emptyRegistryState());
  }

  async function updateState<T>(mutate: (state: DesktopBrowserDeviceRegistryState) => T): Promise<T> {
    await readState();
    let settled = false;
    let result: T | undefined;
    const next = await update(REGISTRY_STATE_ID, (current) => {
      const state = cloneRegistryState(current);
      result = mutate(state);
      settled = true;
      return state;
    });
    if (!next || !settled) throw new Error("desktop browser device registry state update failed");
    return result as T;
  }

  function claimForTask(
    state: DesktopBrowserDeviceRegistryState,
    waitingTaskId: string,
  ): DesktopBrowserTaskClaimRecord | null {
    return state.taskClaims[waitingTaskId] ?? null;
  }

  function currentProjectHead(
    state: DesktopBrowserDeviceRegistryState,
    projectId: string,
  ): DesktopBrowserRegistrationRecord | null {
    const head = state.projectHeads[projectId];
    if (!head) return null;
    return state.registrations[head.registrationId] ?? null;
  }

  async function invalidate(registrationId: string): Promise<void> {
    const at = now();
    await updateState((state) => {
      const current = state.registrations[registrationId];
      if (!current) return;
      state.registrations[registrationId] = offlineRecord(current, at);
    });
  }

  return {
    async reserve(input) {
      try {
        decodeDevicePublicKey(input.devicePublicKey);
      } catch {
        return { status: "refused", reason: "device public key is invalid" };
      }
      const createdAt = now();
      const registrationId = deterministicRegistrationId(input);
      const expiresAtMs = createdAt + reservationTtlMs;
      const registrationTuple: DesktopBrowserRegistrationReservationTuple = {
        registrationProtocolVersion: DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION,
        deploymentCanonicalId: options.deploymentCanonicalId,
        registrationId,
        actorId: input.actorId,
        originatingProjectId: input.projectId,
        membershipEpoch: input.membershipEpoch,
        devicePublicKey: input.devicePublicKey,
        brokerInstanceId: input.brokerInstanceId,
        browserInstanceId: input.browserInstanceId,
        connectionEpoch: input.connectionEpoch,
        expiresAt: iso(expiresAtMs),
      };
      const publicIdentity = projectDesktopBrowserPublicIdentity(registrationTuple);
      const confirmationFingerprint = computeDesktopBrowserRegistrationConfirmationFingerprint(registrationTuple);
      const publicDeviceFingerprint = computeDesktopBrowserPublicDeviceFingerprint(publicIdentity);
      const record: DesktopBrowserRegistrationRecord = {
        registrationId,
        waitingTaskId: input.waitingTaskId,
        actorId: input.actorId,
        projectId: input.projectId,
        membershipEpoch: input.membershipEpoch,
        authorityId: input.authorityId,
        authorityExpiresAt: input.authorityExpiresAt,
        status: "pending",
        registrationTuple,
        publicIdentity,
        confirmationFingerprint,
        publicDeviceFingerprint,
        operatingSystem: input.operatingSystem,
        browserRuntimeStatus: "offline",
        pendingConfirmation: null,
        lastSeenAt: iso(createdAt),
        createdAt,
        updatedAt: createdAt,
      };
      return await updateState<DesktopBrowserReservationResult>((state) => {
        if (claimForTask(state, input.waitingTaskId)) {
          return { status: "refused", reason: "desktop browser task already confirmed a device" };
        }
        const existing = state.registrations[registrationId];
        if (!existing) {
          state.registrations[registrationId] = record;
          return { status: "ok", reservation: reservationView(record) };
        }
        const expired =
          Date.parse(existing.registrationTuple.expiresAt) <= createdAt || existing.authorityExpiresAt <= createdAt;
        if (existing.status === "pending" && !expired && sameReservationInput(existing, input)) {
          return { status: "ok", reservation: reservationView(existing) };
        }
        state.registrations[registrationId] = record;
        return { status: "ok", reservation: reservationView(record) };
      });
    },

    async challengeBinding(registrationId) {
      const record = (await readState()).registrations[registrationId] ?? null;
      if (!record || record.status !== "pending") return null;
      if (Date.parse(record.registrationTuple.expiresAt) <= now()) {
        await invalidate(registrationId);
        return null;
      }
      return {
        registrationId,
        devicePublicKey: record.registrationTuple.devicePublicKey,
        brokerInstanceId: record.registrationTuple.brokerInstanceId,
        browserInstanceId: record.registrationTuple.browserInstanceId,
        connectionEpoch: record.registrationTuple.connectionEpoch,
        expiresAt: record.registrationTuple.expiresAt,
      };
    },

    async get(registrationId) {
      return (await readState()).registrations[registrationId] ?? null;
    },

    async taskRegistration(waitingTaskId) {
      const registrations = Object.values((await readState()).registrations)
        .filter((record) => record.waitingTaskId === waitingTaskId)
        .filter((record) => {
          if (record.status === "online") return true;
          return record.status === "pending" && Date.parse(record.registrationTuple.expiresAt) > now();
        })
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
      return registrations[0] ? taskRegistrationProjection(registrations[0]) : null;
    },

    async stagedConfirmation(registrationId) {
      const pending = (await readState()).registrations[registrationId]?.pendingConfirmation ?? null;
      return pending
        ? {
            browserRuntimeStatus: pending.browserRuntimeStatus,
            envelope: pending.envelope,
          }
        : null;
    },

    async stageConfirmation(input) {
      const record = (await readState()).registrations[input.registrationId] ?? null;
      if (!record) return { status: "refused", reason: "registration not found" };
      if (record.status !== "pending") return { status: "refused", reason: "registration is no longer pending" };
      if (Date.parse(record.registrationTuple.expiresAt) <= now() || record.authorityExpiresAt <= now()) {
        await invalidate(input.registrationId);
        return { status: "refused", reason: "registration reservation expired" };
      }
      const envelope = verifiedEnvelope(record, input.envelope);
      if (!envelope) return { status: "refused", reason: "registration signature verification failed" };
      const at = now();
      return await updateState((state) => {
        const stored = state.registrations[input.registrationId];
        if (!stored) return { status: "refused", reason: "registration not found" };
        if (stored.status !== "pending") return { status: "refused", reason: "registration is no longer pending" };
        if (Date.parse(stored.registrationTuple.expiresAt) <= at || stored.authorityExpiresAt <= at) {
          state.registrations[input.registrationId] = offlineRecord(stored, at);
          return { status: "refused", reason: "registration reservation expired" };
        }
        const nextPending = {
          browserRuntimeStatus: input.browserRuntimeStatus,
          envelope,
        };
        if (stored.pendingConfirmation && !samePendingConfirmation(stored.pendingConfirmation, nextPending)) {
          return { status: "refused", reason: "registration confirmation envelope already staged" };
        }
        const nextRecord = {
          ...stored,
          pendingConfirmation: {
            browserRuntimeStatus: input.browserRuntimeStatus,
            envelope,
            receivedAt: stored.pendingConfirmation?.receivedAt ?? at,
          },
          updatedAt: at,
        };
        state.registrations[input.registrationId] = nextRecord;
        return { status: "ok", registration: taskRegistrationProjection(nextRecord) } as const;
      });
    },

    async confirm(input) {
      const record = (await readState()).registrations[input.registrationId] ?? null;
      if (!record) return { status: "refused", reason: "registration not found" };
      if (record.status !== "pending") return { status: "refused", reason: "registration is no longer pending" };
      if (!constantTimeEqual(record.authorityId, input.authorityId) || record.authorityExpiresAt <= now()) {
        await invalidate(input.registrationId);
        return { status: "refused", reason: "reservation authority is no longer current" };
      }
      if (Date.parse(record.registrationTuple.expiresAt) <= now()) {
        await invalidate(input.registrationId);
        return { status: "refused", reason: "registration reservation expired" };
      }
      const envelope = verifiedEnvelope(record, input.envelope);
      if (!envelope) {
        await invalidate(input.registrationId);
        return { status: "refused", reason: "registration signature verification failed" };
      }
      const at = now();
      return await updateState<DesktopBrowserConfirmationResult>((state) => {
        const stored = state.registrations[input.registrationId];
        if (!stored) return { status: "refused", reason: "registration not found" };
        if (stored.status !== "pending") return { status: "refused", reason: "registration is no longer pending" };
        if (!constantTimeEqual(stored.authorityId, input.authorityId) || stored.authorityExpiresAt <= at) {
          state.registrations[input.registrationId] = offlineRecord(stored, at);
          return { status: "refused", reason: "reservation authority is no longer current" };
        }
        if (Date.parse(stored.registrationTuple.expiresAt) <= at) {
          state.registrations[input.registrationId] = offlineRecord(stored, at);
          return { status: "refused", reason: "registration reservation expired" };
        }
        if (!sameRegistrationTuple(stored.registrationTuple, record.registrationTuple)) {
          state.registrations[input.registrationId] = offlineRecord(stored, at);
          return { status: "refused", reason: "registration tuple no longer matches reservation" };
        }
        const claim = claimForTask(state, stored.waitingTaskId);
        if (claim) {
          if (claim.registrationId !== stored.registrationId) {
            state.registrations[input.registrationId] = offlineRecord(stored, at);
          }
          return {
            status: "refused",
            reason:
              claim.registrationId === stored.registrationId
                ? "registration is no longer pending"
                : "desktop browser task already confirmed a device",
          };
        }
        state.taskClaims[stored.waitingTaskId] = {
          waitingTaskId: stored.waitingTaskId,
          registrationId: stored.registrationId,
          projectId: stored.projectId,
          actorId: stored.actorId,
          membershipEpoch: stored.membershipEpoch,
          authorityId: stored.authorityId,
          authorityExpiresAt: stored.authorityExpiresAt,
          brokerInstanceId: stored.registrationTuple.brokerInstanceId,
          browserInstanceId: stored.registrationTuple.browserInstanceId,
          connectionEpoch: stored.registrationTuple.connectionEpoch,
          claimedAt: at,
        };
        onConfirmMutation?.("afterTaskClaimWrite");
        const current = {
          ...stored,
          status: "online" as const,
          browserRuntimeStatus: input.browserRuntimeStatus,
          pendingConfirmation: null,
          updatedAt: at,
          lastSeenAt: iso(at),
        };
        state.registrations[current.registrationId] = current;
        onConfirmMutation?.("afterCurrentRegistrationInstall");
        const previous = currentProjectHead(state, current.projectId);
        state.projectHeads[current.projectId] = {
          projectId: current.projectId,
          registrationId: current.registrationId,
          updatedAt: at,
        };
        onConfirmMutation?.("afterProjectHeadInstall");
        if (previous && previous.registrationId !== current.registrationId) {
          state.registrations[previous.registrationId] = offlineRecord(previous, at);
        }
        for (const sibling of Object.values(state.registrations)) {
          if (sibling.registrationId === current.registrationId || sibling.waitingTaskId !== current.waitingTaskId) {
            continue;
          }
          state.registrations[sibling.registrationId] = offlineRecord(sibling, at);
        }
        onConfirmMutation?.("afterSiblingReservationInvalidate");
        return { status: "ok", device: toProjection(current) };
      });
    },

    async markOffline(input) {
      const at = now();
      return await updateState<DesktopBrowserOfflineResult>((state) => {
        const stored = state.registrations[input.registrationId];
        if (!stored) return { status: "refused", reason: "registration not found" };
        const tuple = stored.registrationTuple;
        if (
          tuple.brokerInstanceId !== input.brokerInstanceId ||
          tuple.browserInstanceId !== input.browserInstanceId ||
          tuple.connectionEpoch !== input.connectionEpoch
        ) {
          return { status: "refused", reason: "registration connection is no longer current" };
        }
        const updated = offlineRecord(stored, at);
        state.registrations[input.registrationId] = updated;
        return { status: "ok", device: toProjection(updated) };
      });
    },

    invalidate,

    async projectProjection(projectId) {
      const record = currentProjectHead(await readState(), projectId);
      return record ? toProjection(record) : null;
    },

    async relayBinding(input) {
      const at = now();
      const state = await readState();
      const bindings = Object.values(state.registrations)
        .filter(
          (record) =>
            record.registrationTuple.devicePublicKey === input.devicePublicKey &&
            record.registrationTuple.brokerInstanceId === input.brokerInstanceId,
        )
        .filter((record) => {
          if (record.status === "pending") {
            return Date.parse(record.registrationTuple.expiresAt) > at && record.authorityExpiresAt > at;
          }
          return record.status === "online";
        })
        .map(relayBindingFromRecord)
        .filter((binding): binding is DesktopBrowserRelayRegistryBinding => binding !== null)
        .sort(compareRelayBindings);
      return bindings[0] ?? null;
    },

    async publishRelayConnection(projection) {
      await updateState((state) => {
        state.relayConnections[projection.connectionId] = { ...projection };
      });
    },

    async clearRelayConnection(connectionId) {
      await updateState((state) => {
        delete state.relayConnections[connectionId];
      });
    },
  };
}
