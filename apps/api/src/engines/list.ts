/**
 * The engine list (architecture, "Outbound engines"): the core would know an
 * outbound engine's own behaviour only through this file, and an import rule
 * (`scripts/import-rules.json`) holds it there. Empty since Claude Code's
 * routines were retired ("Retire the agents' dock and routines, keeping what
 * each agent knew", issue 1165): Cockpit now hands work to Claude through a
 * `claude://` link the person opens, and starts nothing itself. The analogue
 * of `connectors/registry.ts`, which a next engine would add a line to.
 */
export {};
