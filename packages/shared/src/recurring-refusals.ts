// Apart from `recurring-items.ts`, whose schemas a window that only says a refusal should not carry.

/**
 * Why a recurring item is refused, in the words the person is told beside the
 * field. The screen tells them apart by these, so the words are one definition.
 */
export const RECURRING_REFUSALS = {
  nextOnPassed: 'Next on cannot be before today.',
  panelGone: 'A Panel it files on is no longer in this Workspace.',
  gone: 'That recurring item is no longer there.',
  alreadyMade: 'That recurring item is already made.',
} as const;
