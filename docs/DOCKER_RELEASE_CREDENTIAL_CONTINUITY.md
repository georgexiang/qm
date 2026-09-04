# Docker Release Credential Continuity

## Purpose

Use this checklist when a Docker deployment replaces Core or sandbox images while resident sandboxes retain user-installed CLIs and device-flow authentication.

A release is incomplete until existing resident credentials work through the real Core-to-sandbox execution path without a new login.

## Persistence Contract

Resident CLI state lives in each sandbox home volume. Replacing an application image must preserve:

- The sandbox container scope label.
- The `qm-home-*` named volume for that complete scope ID.
- User-installed executables under `$HOME/.local/bin`.
- Provider profiles and token caches under provider-specific home paths.
- Encrypted device-flow backups and credential liveness records.

Never infer a complete scope ID from a truncated Docker container name. Read the `qm.scope` label.

Do not run `qm down --purge`, `docker volume rm`, or broad Docker cleanup during an application release.

## Runtime Contract

Sandbox commands must:

- Apply explicit per-turn `HOME` and `PATH` values before augmenting command discovery.
- Prepend the resolved `$HOME/.local/bin` to the resolved `PATH`.
- Reconnect a replacement Core to an already-running sandbox network.
- Wait for the sandbox daemon after the network connection succeeds.
- Apply the same readiness behavior to resident and scratch sandboxes.
- Bound daemon readiness waits and fail with a precise error.

The required fixes are present in:

- `1f8724c`: restore persisted CLI command discovery.
- `0d1c5a9`: wait for the daemon after replacement-Core reconnect.

## Authorization Contract

Execution approval and credential authorization are different operations.

- Natural-language approval does not create a keychain grant.
- A personal credential is implied only in its owner's Personal Scope.
- A personal credential used in a shared Project requires an explicit grant from its owner to the complete Project scope.
- A Project-owned resident credential restores for that Project scope without borrowing a participant's personal credential.
- File credentials and resident CLI caches are not automatically injected as standing environment credentials.

## Pre-Release Inventory

Record the current Core image, resident sandbox containers, complete scope labels, and home volumes:

```bash
docker inspect qm-agentops-core --format '{{.Config.Image}}|{{.Image}}'

docker ps -a --filter 'label=qm.sandbox=1' \
  --format '{{.Names}}|{{.Status}}|{{.Image}}'

for container in $(docker ps -a --filter 'label=qm.sandbox=1' --format '{{.Names}}'); do
  docker inspect "$container" \
    --format '{{index .Config.Labels "qm.scope"}}|{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}'
done
```

For the test scope, record only file metadata. Never print token cache contents:

```bash
docker exec TEST_SANDBOX sh -lc '
  for file in \
    "$HOME/.local/bin/az" \
    "$HOME/.azure/msal_token_cache.json" \
    "$HOME/.azure/azureProfile.json"; do
    if [ -e "$file" ] || [ -L "$file" ]; then
      stat -c "%n|%s|%y|%a" "$file"
    else
      printf "%s|MISSING\n" "$file"
    fi
  done
'
```

Also record credential metadata, grant scopes, and liveness state without decrypting credentials.

## Required Automated Tests

Run the local sandbox, shell environment, device-flow persistence, and keychain suites:

```bash
node --experimental-test-module-mocks --test \
  test/local-sandbox.test.ts \
  test/sandbox-noninteractive.test.ts \
  test/device-flow-persist.test.ts \
  test/keychain.test.ts

npm run typecheck
```

The local sandbox suite must cover replacement Core reconnect for both resident and scratch containers. The regression must prove a second daemon health check occurs after reconnecting to an already-running sandbox.

## Required Production Fault Injection

After replacing Core, keep an existing test sandbox and its home volume. Disconnect only the replacement Core from the sandbox network:

```bash
docker network disconnect TEST_SANDBOX_NETWORK qm-agentops-core
```

Immediately call the real local sandbox `provision()` and `run()` path for the complete scope ID. Run a safe identity command such as:

```bash
az account show \
  --query '{tenantId:tenantId,subscriptionId:id,subscriptionName:name,account:user.name}' \
  --output json
```

The release passes only when:

- Core is disconnected before the test.
- `provision()` reconnects Core automatically.
- Daemon readiness succeeds within the bounded timeout.
- The command returns the existing account without a new login.
- The original sandbox container and home volume remain unchanged.
- Core is connected to the sandbox network after the test.
- No new `tree_materialize_failed`, `device_flow_restore_failed`, or `resident_auth_probe_failed` event appears.

Park the test sandbox normally after validation. Do not destroy its home volume.

## Release Evidence

Record:

- Source commit and immutable Core image digest.
- Test counts and static-check results.
- Independent review result.
- Pre-release and post-release scope-to-volume mapping.
- Provider credential file metadata before and after.
- Fault-injection reconnect duration.
- Filtered account and subscription identity.
- Credential-continuity error counts.
- Rollback image digest and configuration backup.

Never record access tokens, refresh tokens, client secrets, private keys, or credential file contents.
