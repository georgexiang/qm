---
status: accepted
---

# Deployment-shared Browser Principal

A BrowserSkill profile registered through a Broker Device is a Deployment-shared Browser Principal. After explicit local confirmation, authenticated deployment users may use the login identities available to that profile without per-user or per-Project profile ACLs.

## Consequences

Every Task records the acting QM actor and Project. Registration displays that QM will control the browser and that the profile is shared across the deployment.
