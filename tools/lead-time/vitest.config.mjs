import { sessionRunReporter } from '../../scripts/lib/vitest-session-reporter.mjs';

export default { test: { reporters: ['default', sessionRunReporter] } };
