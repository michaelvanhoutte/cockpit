//
// Every date the published architecture page (tools/architecture) shows is
// Belgian: the zone and region are fixed, since the people who read
// the page are in Belgium and it is a static file that cannot ask who is
// looking. The model file beside the page keeps its ISO UTC times; only what a
// reader sees goes through here. One module, so a new page cannot pick a zone of its
// own (the Harness Monitor's twin is apps/harness-monitor/src/belgium.ts).
//
// Pure: instants in, text out. No clock is read.
//

const dateFormat = new Intl.DateTimeFormat('en-BE', { timeZone: 'Europe/Brussels', day: 'numeric', month: 'short', year: 'numeric' });

/** 22 Oct 2026: the Belgian day an instant, given as an ISO string, a Date or epoch milliseconds, falls on. */
export const formatDate = (instant) => dateFormat.format(typeof instant === 'number' ? instant : new Date(instant).getTime());
