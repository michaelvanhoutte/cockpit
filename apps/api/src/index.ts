import app from './http/app.js';
import { handleScheduled } from './jobs/index.js';

export type { AppType } from './http/app.js';

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
