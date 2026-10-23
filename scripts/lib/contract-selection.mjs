//
// Which suites a contract run picks up ("Check each Claude prompt with one call
// in CI, and run its behaviour suite by hand", issue 1476). Read by
// apps/api/vitest.contract.config.ts, which runs the files, and by
// scripts/lib/contract-selection.test.mjs, which holds the decision: a run that
// names nothing - CI on a pull request, the weekly run, a bare run by hand -
// takes the one-call checks and the free suites and never a behaviour suite,
// because the weekly run carries the Claude key and must not rest on a
// workflow's file list to stay off the model.
//

/** A behaviour suite is the cases one prompt version is held to, so its file name carries the version: `clean-up-a-note.v17.test.ts`. */
export const BEHAVIOUR_SUITE = /\.v\d+\.test\.ts$/;

/** The file holding one call per Claude prompt. */
export const ONE_CALL_CHECKS = 'one-call.test.ts';

const COMMANDS = new Set(['run', 'watch', 'dev', 'related', 'bench', 'list', 'init']);

/** Vitest options that take their value as the next argument, which is therefore not a name. */
const TAKE_A_VALUE = new Set([
  '-c', '--config', '-t', '--testNamePattern', '-r', '--root', '--dir', '--reporter', '--outputFile',
  '--project', '--shard', '--pool', '--environment', '--mode', '--retry', '--testTimeout', '--maxWorkers',
]);

/** What a Vitest command line names - the words that filter files - given its `process.argv`. */
export function suitesNamed(argv) {
  const args = argv.slice(2);
  if (COMMANDS.has(args[0])) args.shift();
  const named = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === '--') continue;
    if (TAKE_A_VALUE.has(arg)) at += 1;
    else if (!arg.startsWith('-')) named.push(arg);
  }
  return named;
}

/** The prompt a behaviour suite holds, `clean-up-a-note` for `area/clean-up-a-note.v17.test.ts`. */
const promptOf = (file) => file.split('/').pop().replace(BEHAVIOUR_SUITE, '');

/**
 * The files a run is given to filter. Every file but the behaviour suites, and
 * a behaviour suite only where a name is part of its prompt's name - so a
 * stray value read as a name (`--bail 1`) selects none of them. Vitest then
 * keeps those whose path holds a name, which no one-call check or free suite
 * does for a behaviour suite's name.
 */
export function contractFiles(files, named) {
  return files.filter((file) => !BEHAVIOUR_SUITE.test(file) || named.some((name) => promptOf(file).includes(name)));
}

/** The files Vitest runs once it has filtered `files` by `named` as its command line does. */
export function filesRun(files, named) {
  const given = contractFiles(files, named);
  return named.length === 0 ? given : given.filter((file) => named.some((name) => file.includes(name)));
}

/**
 * The versioned prompt names (`clean-up-a-note.v17`) that open no case title in
 * `check`'s source, as `X.vN` and not as the front of `X.vNN` - a title and not
 * anywhere, since a comment naming the prompt checks nothing.
 */
export function promptsWithoutACheck(prompts, check) {
  return prompts.filter((prompt) => !new RegExp(`\\bit\\(\\s*['"\`]${prompt.replace(/\./g, '\\.')}(?!\\d)`).test(check));
}

/** The suites, other than the one-call checks, that ask Claude and are not named as behaviour suites - so would run on a bare run. */
export function claudeSuitesRunBare(sources) {
  return Object.keys(sources).filter(
    (file) => file !== ONE_CALL_CHECKS && !BEHAVIOUR_SUITE.test(file) && sources[file].includes('ClaudeAiService'),
  );
}
