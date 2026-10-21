import gmail from './marks/gmail.svg?inline';
import neutral from './marks/neutral.svg?inline';
import outlook from './marks/outlook.svg?inline';
import teams from './marks/teams.svg?inline';
import textMessages from './marks/text-messages.svg?inline';

/**
 * The mark each source is known by, on the tile a connection card and an Add
 * connection entry both put it on ("Show each connection as its own card",
 * issue 1349).
 *
 * **Static artwork, inlined into the Settings chunk** (`ManageConnections` is
 * lazy), so the initial bundle never carries it. Each is a file under `marks/`
 * rather than JSX, since a brand's colours are the brand's and not the theme's
 * (`theme-tokens.mjs` allows a literal colour nowhere but `styles.css`).
 *
 * **Text messages takes a plain green chat bubble**, since Twilio is plumbing
 * the person never sees; a connector with no mark of its own takes a neutral
 * disc and is still named beside it.
 */
const MARKS: Record<string, string> = {
  gmail,
  outlook,
  teams,
  twilio: textMessages,
};

export function SourceMark({ connectorId }: { connectorId: string }) {
  // Own keys only, so a connector called `constructor` is never read off the prototype.
  const mark = Object.hasOwn(MARKS, connectorId) ? MARKS[connectorId]! : neutral;
  return (
    // The tile is white in every appearance, since a mark is drawn for white.
    <span
      aria-hidden
      className="grid size-11 shrink-0 place-items-center rounded-xl border border-shade/10 bg-mark-tile shadow-sm"
    >
      <img src={mark} alt="" className="size-7 object-contain" />
    </span>
  );
}
