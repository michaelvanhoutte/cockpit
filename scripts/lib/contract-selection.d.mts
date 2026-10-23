export const BEHAVIOUR_SUITE: RegExp;
export const ONE_CALL_CHECKS: string;
export function suitesNamed(argv: readonly string[]): string[];
export function contractFiles(files: readonly string[], named: readonly string[]): string[];
export function filesRun(files: readonly string[], named: readonly string[]): string[];
export function promptsWithoutACheck(prompts: readonly string[], check: string): string[];
export function claudeSuitesRunBare(sources: Record<string, string>): string[];
