/**
 * A Dashboard's whiteboard and the swatches its boxes take ("Brainstorming:
 * give every Dashboard a whiteboard of its own", issue 1829), in an entry point
 * of their own (`@cockpit/shared/board`) so the app's initial bundle carries
 * none of it: the whiteboard is a chunk fetched when it is drawn.
 */
export * from './domain/board.js';
export * from './domain/swatches.js';
