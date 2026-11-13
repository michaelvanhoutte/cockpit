/**
 * What the pages of the services view share: the trail of crumbs under the name of the report, and the switch between
 * a page's tabs (Logical and Deployment, Modules and Dependencies, Relations and All columns).
 */

import { esc } from './svg.js';

/** The front page of the report, the services page's Design tab, and the whole-app Modules page beside it. */
export const SERVICES_DESIGN_FILE = 'services-design.html';
export const MODULES_FILE = 'modules.html';

/** Where every page's trail starts: the report's front page. */
export const SERVICES_TRAIL = [['Architecture', SERVICES_DESIGN_FILE]];

/** The same trail for a report that has no `serviceMap`, and so no front page: it starts at the Modules page. */
export const trailOf = (model) => (model.serviceMap ? SERVICES_TRAIL : [['Architecture', MODULES_FILE]]);

/** @param {[string, string?][]} crumbs a crumb with no address is the page itself */
export const crumbTrail = (crumbs) => crumbs.map(([label, href]) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label))).join(' › ');

/** @param {[string, string, boolean][]} tabs label, address and whether it is the page shown */
export const switchNav = (tabs) => (tabs ? `<nav class="switch">${tabs.map(([label, href, on]) => (on ? `<span class="on">${esc(label)}</span>` : `<a href="${esc(href)}">${esc(label)}</a>`)).join('')}</nav>` : '');

/** Words from the description file as HTML: escaped, with a repository path or a name between backticks set as code. */
export const prose = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
