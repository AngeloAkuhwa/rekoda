/**
 * Next gives `string | string[] | undefined` for a query param — repeating it
 * (`?phone=a&phone=b`) yields an array. Calling string methods on that threw a
 * TypeError the page's catch did not handle, turning a crafted URL into an
 * unauthenticated 500. Always narrow through here.
 */
export function firstParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}
