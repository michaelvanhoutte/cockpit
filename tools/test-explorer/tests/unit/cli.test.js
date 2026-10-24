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

  it('sets json for --json', () => {
    expect(parseArgs(['--json'])).toEqual({ json: true });
  });

  it('sets checkConcepts for --check-concepts', () => {
    expect(parseArgs(['--check-concepts'])).toEqual({ checkConcepts: true });
  });

  it('consumes the following argument as the value for --out and --repo', () => {
    expect(parseArgs(['--out', 'out/model.json', '--repo', '/some/repo'])).toEqual({
      out: 'out/model.json',
      repo: '/some/repo',
    });
  });

  it('combines multiple recognized flags', () => {
    expect(parseArgs(['--json', '--out', 'x.json'])).toEqual({ json: true, out: 'x.json' });
  });

  it.each([
    { flag: '--model', parsed: { model: 'm.json' } },
    { flag: '--send', parsed: { send: 'm.json' } },
  ])('consumes the model file after $flag, and refuses $flag without one', ({ flag, parsed }) => {
    expect(parseArgs([flag, 'm.json'])).toEqual(parsed);
    expect(parseArgs([flag])).toEqual({ invalid: `${flag} needs a path to a model file` });
    expect(parseArgs([flag, '--json'])).toEqual({ invalid: `${flag} needs a path to a model file` });
  });

  it('returns { unknown } for an unrecognized argument instead of exiting the process', () => {
    expect(parseArgs(['--nope'])).toEqual({ unknown: '--nope' });
  });

  it('stops at the first unrecognized argument, ignoring anything after it', () => {
    expect(parseArgs(['--json', '--nope', '--out', 'x.json'])).toEqual({ unknown: '--nope' });
  });
});
