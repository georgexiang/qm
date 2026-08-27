# 01 — Add capability authority lineage

**What to build:** Add server-issued authority, Session, Turn, and optional Run lineage to QM
capabilities so retained local-browser work can prove its origin without trusting request fields.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] Human-Turn capabilities carry immutable authority, Session, Turn, and optional Run lineage.
- [x] Verification accepts typed lineage while preserving existing capability audiences.
- [x] Local-browser authorization rejects legacy Tokens without required lineage.
- [x] Caller identity, lineage, and expiry fields cannot override verified claims.
- [x] Tests cover issuance, compatibility, expiry, and forgery rejection.
