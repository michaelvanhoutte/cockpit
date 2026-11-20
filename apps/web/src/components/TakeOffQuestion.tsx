import type { ItemOnWhiteboards } from '@cockpit/shared/board';
import { answerTheQuestion, useWhiteboardQuestion } from '../whiteboardQuestion';
import { DeleteQuestion } from './DeleteQuestion';

/**
 * "Take it off there too?" ("Brainstorming: give every Dashboard a whiteboard
 * of its own", issue 1829), asked when a change would send Items with cards to
 * the Inbox, where an Item is never on a whiteboard (`whiteboardQuestion.ts`).
 * *Take off both* makes the change and takes the cards off every board, and one
 * Undo restores both; *Cancel* changes nothing. Fetched only when asked, so it
 * costs the initial bundle nothing.
 */
export default function TakeOffQuestion() {
  const question = useWhiteboardQuestion();
  if (!question) return null;
  return (
    <DeleteQuestion
      open
      question={questionLine(question.items)}
      confirmText="Take off both"
      confirmLabel="Take off both"
      variant="affirmative"
      onCancel={() => answerTheQuestion(false)}
      onConfirm={() => answerTheQuestion(true)}
    />
  );
}

/** The question's one line: the Item and the Dashboards it is on, or how many Items for several. */
export function questionLine(items: readonly ItemOnWhiteboards[]): string {
  const [first] = items;
  if (items.length === 1 && first) {
    const where = [...new Set(first.cards.map((card) => card.dashboardName))];
    return `${first.title} is also on the whiteboard of ${where.join(', ')}. Take it off there too?`;
  }
  return `${items.length} Items are also on whiteboards. Take them off there too?`;
}
