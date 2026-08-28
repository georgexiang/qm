#!/usr/bin/env node
import { migratePostgresDesktopBrowserRelayOperationStore } from "../operation-postgres.ts";

const connectionString = process.env.QM_RELAY_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error("QM_RELAY_MIGRATION_DATABASE_URL is required");
const runtimeRole = process.env.QM_RELAY_DATABASE_RUNTIME_ROLE;
if (!runtimeRole) throw new Error("QM_RELAY_DATABASE_RUNTIME_ROLE is required");
await migratePostgresDesktopBrowserRelayOperationStore({
  connectionString,
  schema: process.env.QM_RELAY_DATABASE_SCHEMA ?? "qm_broker_relay",
  runtimeRole,
});
