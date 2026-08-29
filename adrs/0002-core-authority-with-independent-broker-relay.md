---
status: accepted
---

# Core authority with independent Broker Relay

QM Core owns actor, Project, Browser Task, Execution Attempt, Lease, cancellation, and final outcome. An independently deployed Broker Relay owns Device connections, WSS routing, connection epochs, Current Operation Checkpoints, evidence, callback delivery, and reconnect handling.

## Consequences

Core and Relay use separate service identities and PostgreSQL ownership boundaries. Relay remains able to persist terminal evidence during a Core outage. Shared validation uses multiple Relay instances with connection fencing, drain, and reconnect coverage.
