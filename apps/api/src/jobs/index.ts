import type { ScheduledController } from '@cloudflare/workers-types';
import type { Env } from '../env.js';

/**
 * Background jobs (architecture §6.3): plain functions calling domain/; the
 * queue and cron are adapters. Cron Triggers and Queues get enabled in
 * wrangler.jsonc when the first connector sync and AI enrichment job land.
 */
export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  void controller;
  void env;
  // Connector sync cadences, reconciliation passes, and the dead-man's-switch
  // watchdog (§9.2) are dispatched from here.
}
