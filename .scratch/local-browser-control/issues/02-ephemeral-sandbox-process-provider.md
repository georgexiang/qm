# 02 — Launch deployment-provided ephemeral Sandbox processes

**What to build:** Let a typed QM tool start, observe, and stop one deployment-declared executable
inside an already provisioned scoped computer through a generic provider contract.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] Tool metadata declares a stable executable ID, protocol major, and launch schema.
- [x] Sandbox implementations expose one common start/observe/stop contract.
- [x] Process lifetime is bounded to its owning operation and scope.
- [x] A fake provider proves exactly one process starts and stops per operation.
- [x] Existing deployment tools and Sandbox backends remain compatible.
