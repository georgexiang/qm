---
status: accepted
---

# Current checkpoint with append-only operation evidence

Each Execution Attempt maintains one Relay-owned Current Operation Checkpoint. Acceptance and completion create append-only metadata evidence, while a durable callback outbox temporarily retains the complete terminal projection for idempotent Core delivery.

## Consequences

Delivered callback and Host fence payloads are scrubbed while operation identities, outcomes, and hashes remain. A Host fence without Relay acceptance evidence is recovered as unknown and never authorizes a rerun.
