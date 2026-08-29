---
status: proposed
---

# Full bsk argv passthrough

A later risk slice may allow the Task-scoped `browser_task` tool to accept policy-described BrowserSkill commands beyond the four Phase F operations.

## Consequences

Phase F does not accept this decision. It remains limited to session start, navigate, observe, and session stop. Unknown commands fail closed, and no shell, executable, environment, path, or cross-Task session passthrough is permitted.
