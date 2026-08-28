import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// vitest doesn't enable jest-style test globals by default, so
// testing-library's own auto-cleanup (which detects a global `afterEach`)
// never registers unless it's wired up explicitly here.
afterEach(cleanup);
