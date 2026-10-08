/**
 * The engine list (architecture, "Outbound engines"): the web app reaches an
 * outbound engine's own screens only through this file, and an import rule
 * (`scripts/import-rules.json`) holds it there. The analogue of the
 * connector list the Connections window reads.
 */
export { ConnectClaudeCode as ConnectEngine } from './ConnectClaudeCode';
