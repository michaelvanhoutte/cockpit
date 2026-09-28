import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeAiService, type ItemToPlace } from '../../src/ai/index.js';
import { buildChooseAPanel } from '../../src/ai/prompts/choose-a-panel.v1.js';
import type { DecisionHistoryEntry } from '../../src/domain/decision-history.js';

/**
 * The contract tier for a settled filing's refresh of the rest of an inbox:
 * the real Claude API, the real prompt, no fake anywhere, scheduled and never
 * on a pull request - `clean-up-a-note.v9.test.ts`'s class comment says why,
 * and a failure here is priority work for the same reasons.
 *
 * **The same routing properties that file holds the full prompt to**, on a
 * cheaper model and a narrower prompt ("Use a cheaper model for panel-only
 * re-proposal", issue 583): a clear fit is named and explained, a note that
 * fits nothing gets nothing, no panel is named that was not offered, and a
 * correction in the decision history is followed. The same notes and panel
 * names as there, so a pass here is comparable to a pass there; none is one
 * the prompt carries.
 *
 * **Proposing nothing gets two cases rather than one**, because a narrower,
 * cheaper model is likeliest to fail it: a panel named merely for being the
 * closest match. The second note sits near one panel without belonging on it.
 *
 * **Run first on Sonnet 5, then on Haiku 4.5, and Haiku 4.5 was taken** as
 * the cheaper of two models that both held it, repeatedly - the pull request
 * that introduced this file has the runs.
 */

const key = process.env.ANTHROPIC_API_KEY ?? '';
const spent = { calls: 0, input: 0, output: 0 };
const choosing = new ClaudeAiService(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined, (_model, usage) => {
  spent.calls += 1;
  spent.input += usage.input_tokens;
  spent.output += usage.output_tokens;
});
afterAll(() => console.log(`choose-a-panel.v1: ${JSON.stringify(spent)}`));

/**
 * An Item as a refresh finds it: the note, and the two texts capture proposed
 * for it. Where a case gives no texts, the title is the note and there is no
 * description - an Item capture never cleaned up, which is the least a
 * refresh can be handed.
 */
function anItem(capturedMessage: string, texts?: { title: string; description: string }): ItemToPlace {
  return { capturedMessage, title: texts?.title ?? capturedMessage, description: texts?.description ?? null };
}

async function choose(
  item: ItemToPlace,
  panels: readonly { id: string; name: string }[],
  history: readonly DecisionHistoryEntry[] = [],
) {
  const answer = await choosing.choosePanel(item, panels, history, []);
  // Said out loud, for the same reason `clean-up-a-note.v9.test.ts`'s `read` does.
  if (!('panel' in answer)) throw new Error(`nothing usable came back: ${answer.discarded}`);
  return answer.panel;
}

describe('Triage', () => {
  it('has a key to ask with', () => {
    expect(key, 'set ANTHROPIC_API_KEY, or put it in apps/api/.dev.vars').not.toBe('');
    // The cases below are only evidence about the version and model they ran against.
    expect(buildChooseAPanel(anItem('a note'), [], [], [])).toMatchObject({ version: 'v1', model: 'claude-haiku-4-5' });
  });

  describe('a refresh offers an item the panel it clearly belongs on, and only where one does', () => {
    const panels = [
      { id: '018f0000-0000-7000-8000-000000000001', name: 'Regulatory questions' },
      { id: '018f0000-0000-7000-8000-000000000002', name: 'Weekend ideas' },
    ];
    const COMPLIANCE_ITEM = anItem('gdpr data retention policy needs sign-off before next month’s audit', {
      title: 'Get the GDPR data retention policy signed off',
      description: 'Get the GDPR data retention policy signed off before next month’s audit.',
    });

    it('names the panel and says why, in terms of the item rather than of itself', async () => {
      const panel = await choose(COMPLIANCE_ITEM, panels);

      expect(panel?.panelId).toBe(panels[0]!.id);
      expect(panel?.reason.toLowerCase()).not.toContain('i chose');
      expect(panel?.reason.toLowerCase()).not.toContain('model');
    });

    it.each([
      { situation: 'fits none of them at all', item: anItem('milk, eggs, bread - stop on the way home') },
      {
        situation: 'only sits near one of them',
        item: anItem('renew my passport before the summer trip', {
          title: 'Renew my passport before the summer trip',
          description: 'Renew my passport before the summer trip.',
        }),
      },
    ])('proposes nothing for an item that $situation', async ({ item }) => {
      expect(await choose(item, panels)).toBeNull();
    });

    it('never names a panel it was not offered', async () => {
      const panel = await choose(COMPLIANCE_ITEM, panels);
      if (panel) expect(panels.map((offered) => offered.id)).toContain(panel.panelId);
    });
  });

  /**
   * `clean-up-a-note.v9.test.ts`'s "a proposal follows a correction recorded
   * in the decision history", on this prompt: the note fits either panel
   * equally, so naming the corrected one is a call the history alone drives.
   */
  describe('a refresh follows a correction recorded in the decision history', () => {
    const panels = [
      { id: '018f0000-0000-7000-8000-000000000003', name: 'Compliance questions' },
      { id: '018f0000-0000-7000-8000-000000000004', name: 'Laurens' },
    ];

    it('proposes the corrected panel for a similar item, after an override names it', async () => {
      const history: DecisionHistoryEntry[] = [
        {
          capturedMessage: 'part 11 audit trail q for validation protocol, who signs off eod',
          itemTitle: 'Part 11 audit trail question',
          proposedPanelId: panels[0]!.id,
          proposedPanelName: 'Compliance questions',
          proposedPanelReason: 'a compliance question, about the validation protocol',
          chosenPanelId: panels[1]!.id,
          chosenPanelName: 'Laurens',
          decidedAt: '2026-08-01T09:00:00.000Z',
        },
      ];

      const panel = await choose(anItem('sign-off needed before we can close this out, who owns it'), panels, history);

      expect(panel?.panelId).toBe(panels[1]!.id);
    });
  });
});
