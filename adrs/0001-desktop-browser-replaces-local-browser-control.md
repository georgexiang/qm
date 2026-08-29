---
status: accepted
---

# Desktop Browser replaces Local Browser Control

QM replaces Local Browser Control with Desktop Browser, using Tencent BrowserSkill on the customer desktop. Development starts from pre-feature commit `7cc46791d15a6bb45b41272a6c69b54afd6bcea1`; the existing Local Browser branch remains historical and no old Browser Task compatibility layer is carried forward.

## Consequences

QM depends on a pinned `bsk` CLI and BrowserSkill Extension. Device registration, Relay, Task authority, Stop, unknown-effect handling, and WebUI integration belong to Desktop Browser. BrowserSkill owns the Agent Window and browser automation behavior.