import { useState } from 'react';

/** What a person picks: one of the two, or neither - the device decides. */
type Choice = 'match' | 'light' | 'dark';

/**
 * Where the choice is kept: this browser, not the account, as the dictation
 * language is (`dictation.ts`). `appearanceBoot.js` reads the same key before
 * the app runs, so the two must agree; it is not forgotten at sign-out, since
 * it says nothing about whoever was signed in.
 */
export const APPEARANCE_KEY = 'cockpit.appearance';

/** The event `appearanceBoot.js` listens for to apply this tab's own choice at once. */
export const APPEARANCE_EVENT = 'cockpit:appearance';

const OPTIONS: { value: Choice; label: string; hint?: string }[] = [
  { value: 'match', label: 'Match device', hint: 'Light or dark, as this device is set.' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function stored(): Choice {
  try {
    const value = window.localStorage.getItem(APPEARANCE_KEY);
    return value === 'light' || value === 'dark' ? value : 'match';
  } catch {
    return 'match';
  }
}

/**
 * Settings' Appearance: Match device, Light or Dark, with the current choice
 * selected ("Choose Light, Dark or Match device in Settings, on a phone too",
 * issue 844). A choice applies at once and is remembered on this device; Match
 * device clears the stored one. Where storage refuses, it still applies to this
 * visit and is simply not remembered.
 */
export default function ManageAppearance() {
  const [choice, setChoice] = useState(stored);

  const choose = (next: Choice) => {
    setChoice(next);
    try {
      if (next === 'match') window.localStorage.removeItem(APPEARANCE_KEY);
      else window.localStorage.setItem(APPEARANCE_KEY, next);
    } catch {
      // Not remembered; this visit still uses the choice.
    }
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: next === 'match' ? null : next }));
  };

  return (
    <section>
      <h3 className="text-base font-semibold">Appearance</h3>
      <p className="mt-1 text-sm text-ink-faint">Remembered on this device.</p>
      <div role="radiogroup" aria-label="Appearance" className="mt-4 flex flex-col gap-3">
        {OPTIONS.map(({ value, label, hint }) => (
          <label key={value} className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="appearance"
              className="mt-1"
              checked={choice === value}
              onChange={() => choose(value)}
            />
            <span>
              <span className="text-ink">{label}</span>
              {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
