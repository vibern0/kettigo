import { applyD1Migrations, env as workerEnv } from "cloudflare:test";
declare const __D1_MIGRATIONS__: Parameters<typeof applyD1Migrations>[1];
await applyD1Migrations((workerEnv as unknown as { PROOF_DB: D1Database }).PROOF_DB, __D1_MIGRATIONS__);
