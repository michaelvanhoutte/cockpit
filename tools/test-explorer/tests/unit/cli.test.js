import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli.js';

describe('parseArgs', () => {
  it('returns an empty object for no arguments', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('sets help for --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['-h'])).toEqual({ help: true });
  });

  it('sets checkConcepts for --check-concepts', () => {
    expect(parseArgs(['--check-concepts'])).toEqual({ checkConcepts: true });
  });

  it('consumes the following argument as the value for --repo', () => {
    expect(parseArgs(['--repo', '/some/repo'])).toEqual({ repo: '/some/repo' });
  });

  it('combines multiple recognized flags', () => {
    expect(parseArgs(['--repo', '/some/repo', '--model', 'x.json'])).toEqual({ repo: '/some/repo', model: 'x.json' });
  });

  it('no longer knows the flags that chose a page', () => {
    expect(parseArgs(['--json'])).toEqual({ unknown: '--json' });
    expect(parseArgs(['--out', 'x.html'])).toEqual({ unknown: '--out' });
  });

  it.each([
    { flag: '--model', parsed: { model: 'm.json' } },
    { flag: '--send', parsed: { send: 'm.json' } },
  ])('consumes the model file after $flag, and refuses $flag without one', ({ flag, parsed }) => {
    expect(parseArgs([flag, 'm.json'])).toEqual(parsed);
    expect(parseArgs([flag])).toEqual({ invalid: `${flag} needs a path to a model file` });
    expect(parseArgs([flag, '--repo'])).toEqual({ invalid: `${flag} needs a path to a model file` });
  });

  it.each([
    { argv: ['--model', 'm.json', '--check-concepts'], invalid: '--model writes the model, so it does not combine with --check-concepts' },
    { argv: ['--send', 'm.json', '--repo', '.'], invalid: '--send reads a model and writes nothing, so it takes no option but --pull-request' },
    { argv: ['--pull-request', '9001'], invalid: '--pull-request names whose tests --send sends, so it needs --send' },
  ])('refuses $argv, which would silently skip one of them', ({ argv, invalid }) => {
    expect(parseArgs(argv)).toEqual({ invalid });
  });

  it('sends as a pull request with --pull-request, and refuses one that is not a number', () => {
    expect(parseArgs(['--send', 'm.json', '--pull-request', '9001'])).toEqual({ send: 'm.json', pullRequest: 9001 });
    for (const value of ['09001', 'pr-9001', '-1']) expect(parseArgs(['--send', 'm.json', '--pull-request', value])).toEqual({ invalid: '--pull-request needs a pull request number' });
    expect(parseArgs(['--send', 'm.json', '--pull-request'])).toEqual({ invalid: '--pull-request needs a pull request number' });
  });

  it('returns { unknown } for an unrecognized argument instead of exiting the process', () => {
    expect(parseArgs(['--nope'])).toEqual({ unknown: '--nope' });
  });

  it('stops at the first unrecognized argument, ignoring anything after it', () => {
    expect(parseArgs(['--repo', '.', '--nope', '--model', 'x.json'])).toEqual({ unknown: '--nope' });
  });
});
