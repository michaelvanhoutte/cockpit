/**
 * What the pages of the services view share: the trail of crumbs under the name of the report, and the switch between
 * a page's tabs (Logical and Deployment, Modules and Dependencies, Relations and All columns).
 */

import { esc } from './svg.js';

/** Where every page of the services view starts its trail: the report, then the services page. */
export const SERVICES_DESIGN_FILE = 'services-design.html';
export const SERVICES_TRAIL = [['Architecture', 'index.html'], ['Services', SERVICES_DESIGN_FILE]];

/** The same trail for a page of a report that has no `serviceMap`, where there is no services page to link to. */
export const trailOf = (model) => (model.serviceMap ? SERVICES_TRAIL : SERVICES_TRAIL.slice(0, 1));

/** @param {[string, string?][]} crumbs a crumb with no address is the page itself */
export const crumbTrail = (crumbs) => crumbs.map(([label, href]) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label))).join(' › ');

/** @param {[string, string, boolean][]} tabs label, address and whether it is the page shown */
export const switchNav = (tabs) => (tabs ? `<nav class="switch">${tabs.map(([label, href, on]) => (on ? `<span class="on">${esc(label)}</span>` : `<a href="${esc(href)}">${esc(label)}</a>`)).join('')}</nav>` : '');

/** Words from the description file as HTML: escaped, with a repository path or a name between backticks set as code. */
export const prose = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
