/**
 * Which numbers a code may be sent to ("Connect a phone in Settings by
 * confirming a code texted to it", issue 1335): Belgian mobile numbers only.
 *
 * **The first of three guards against SMS pumping**, and the only one that
 * runs before Twilio is asked: a form that texts any number a visitor types is
 * a way to spend the operator's money abroad. The other two are the hourly
 * count the host keeps and Twilio's own geographic permissions.
 */

export const NOT_A_BELGIAN_MOBILE = 'Only Belgian mobile numbers can be connected, like +32 470 12 34 56.';

/** What separates the digits of a number as people type it. */
const SEPARATORS = /[\s.\-/()]/g;

/**
 * The number in plain international format (`+32470123456`), or `null` where
 * what was typed is not a Belgian mobile number.
 *
 * Read the way people write one: with `+32` or `0032`, or nationally with the
 * leading `0`, and with spaces, dots, dashes or slashes between the digits.
 * **A mobile number is `4` and eight digits after the country code**, which is
 * what separates it from a landline: a Belgian landline has an area code of
 * one or two digits and a number of seven or eight, so `+32 2 123 45 67` and
 * Liège's `04 123 45 67` are both too short.
 */
export function belgianMobile(typed: string): string | null {
  const compact = typed.replace(SEPARATORS, '');
  const national = nationalPart(compact);
  return national !== null && /^4\d{8}$/.test(national) ? `+32${national}` : null;
}

/** The digits after the country code, or `null` where the number is not Belgian or has letters in it. */
function nationalPart(compact: string): string | null {
  if (!/^\+?\d+$/.test(compact)) return null;
  // `+32 (0)470…` is written with the trunk zero kept in brackets, once.
  const dropTrunkZero = (rest: string) => rest.replace(/^0/, '');
  if (compact.startsWith('+32')) return dropTrunkZero(compact.slice(3));
  if (compact.startsWith('0032')) return dropTrunkZero(compact.slice(4));
  // A national number starts with the trunk zero, and a second one means another country's.
  if (compact.startsWith('0') && !compact.startsWith('00')) return compact.slice(1);
  return null;
}
