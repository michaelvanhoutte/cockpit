//
// The outside-services rule ("Fail the Checks job when an outside service has
// no live contract case, and hold a pull request whose real-device check was
// not done", issue 1426): every outside `https://` host the product or the
// Harness Monitor names belongs to a listed service that has a live contract
// suite, or a gap saying why not, or is marked as not a call.
//
// The declaration it reads is scripts/outside-services.json. The functions are
// pure over the list and the files' text; `checkTree` is the one that touches
// the tree. Text rather than a parsed tree, so this runs in the checkout-only
// job `test:scripts` has.
//

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isTestFile } from './clock-rule.mjs';
import { readSources, withoutComments } from './provider-calls.mjs';

export const LIST_PATH = 'scripts/outside-services.json';

const HOST = /https:\/\/([a-z0-9][a-z0-9.-]*)/gi;

/**
 * Every host a file's code names after `https://`, comments excluded: a
 * sentence about an address is not a call to it.
 * @param {string} text
 * @returns {string[]}
 */
export function hostsIn(text) {
  const hosts = new Set();
  for (const match of withoutComments(text).matchAll(HOST)) hosts.add(match[1].toLowerCase().replace(/\.+$/, ''));
  return [...hosts];
}

/** @param {string | string[] | undefined} suite */
const suitesOf = (suite) => (suite === undefined ? [] : Array.isArray(suite) ? suite : [suite]);

/** Whether a string holds anything but whitespace. @param {unknown} text */
const said = (text) => typeof text === 'string' && text.trim() !== '';

/**
 * Every failure of the list itself: a suite that does not exist, an entry with
 * neither a suite nor a gap, a gap or an excuse with no reason.
 * @param {List} list
 * @param {(path: string) => boolean} exists
 * @returns {string[]}
 */
export function listFailures(list, exists) {
  const failures = [];
  for (const service of list.services) {
    const suites = suitesOf(service.suite);
    if (suites.length === 0 && service.gap === undefined) {
      failures.push(`${LIST_PATH}: ${service.name} has neither a contract suite nor a gap; name the suite, or the gap and its reason`);
    }
    if (service.gap !== undefined && !said(service.gap) && suites.length === 0) {
      failures.push(`${LIST_PATH}: ${service.name} has a gap with no reason; say why it has no contract suite`);
    }
    for (const suite of suites) {
      if (!exists(suite)) failures.push(`${LIST_PATH}: ${service.name} names the contract suite ${suite}, which does not exist`);
    }
  }
  for (const excused of list.notServices ?? []) {
    if (!said(excused.reason)) failures.push(`${LIST_PATH}: ${excused.host} is marked as not a service with no reason; say why it is not a call`);
  }
  return failures;
}

/**
 * Every outside host in the files that no entry claims, naming host and file.
 * Test files are not calls and are skipped.
 * @param {List} list
 * @param {{ path: string, text: string }[]} files
 * @returns {string[]}
 */
export function unclaimedHosts(list, files) {
  const claimed = new Set([
    ...list.services.flatMap((service) => service.hosts ?? []),
    ...(list.notServices ?? []).map((excused) => excused.host),
  ]);
  const failures = [];
  for (const file of files) {
    if (isTestFile(file.path)) continue;
    for (const host of hostsIn(file.text)) {
      if (!claimed.has(host)) {
        failures.push(`${file.path}: names the outside host ${host}, which no entry in ${LIST_PATH} claims; list its service with a contract suite or a gap, or mark the host as not a service`);
      }
    }
  }
  return failures;
}

/**
 * Every failure over a list and a set of files.
 * @param {List} list
 * @param {{ path: string, text: string }[]} files
 * @param {(path: string) => boolean} exists
 */
export function checkServices(list, files, exists) {
  return [...listFailures(list, exists), ...unclaimedHosts(list, files)];
}

/** Every failure over the real tree. @param {string} root */
export function checkTree(root) {
  const list = JSON.parse(readFileSync(join(root, LIST_PATH), 'utf8'));
  const files = readSources(root, { scan: ['apps', 'packages'] });
  return checkServices(list, files, (path) => existsSync(join(root, path)));
}

/**
 * @typedef {{ name: string, hosts?: string[], suite?: string | string[], gap?: string }} Service
 * @typedef {{ services: Service[], notServices?: { host: string, reason: string }[] }} List
 */
