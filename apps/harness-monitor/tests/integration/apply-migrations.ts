import { applyD1Migrations, env } from 'cloudflare:test';
import { inject } from 'vitest';

await applyD1Migrations(env.DB, inject('migrations'));
