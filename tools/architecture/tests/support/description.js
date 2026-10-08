/** A description file in the real one's shape, small enough to read at a glance; a test overrides what it is about. */
import { stringify } from 'yaml';

export const description = (overrides = {}) => ({
  discover: [
    { path: 'apps/web/src', as: 'one', role: 'core' },
    { path: 'apps/api/src', as: 'folders', rootFiles: true, role: 'core' },
    { path: 'packages', as: 'packages', role: 'core' },
    { path: 'packages/connectors', as: 'packages', role: 'connector' },
  ],
  scan: { extensions: ['.ts', '.tsx'], tests: '(^|/)(tests?|__tests__)/|\.(test|spec)\.tsx?$', ignore: ['node_modules'] },
  sources: [
    { id: 'gmail', name: 'Gmail', words: ['gmail'] },
    { id: 'claude-code', name: 'Claude Code', words: ['claude code'] },
  ],
  connectorRule: { sdk: '@cockpit/connector-sdk', scope: '@cockpit/' },
  context: { cockpit: { name: 'Cockpit', summary: 'Unified inbox and dashboards.' }, people: [], services: [] },
  layers: [],
  ...overrides,
});

/** The file as the generator is handed it. */
export const descriptionFile = (overrides) => ({ file: 'tools/architecture/description.yml', text: stringify(description(overrides)) });
