/**
 * The engine list (architecture, "Outbound engines"): the core knows Claude
 * Code's own behaviour - the trigger check, the fire request, its refusal
 * wording, reading a hook - only through this file, and an import rule
 * (`scripts/import-rules.json`) holds it there. The analogue of
 * `connectors/registry.ts`, which a second engine would add a line to.
 */
export { fireRoutine, testClaudeCodeConnection } from './claude-code.js';
export {
  HOOK_BODY_LIMIT_BYTES,
  HOOK_PATH_PREFIX,
  hookSecretFor,
  isHookSecret,
  waitingFrom,
} from './claude-code-hooks.js';
