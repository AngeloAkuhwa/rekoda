'use server';

import { reminderOptOut } from '@/server/api';

export type OptOutState = 'done' | 'invalid' | 'error';

/** Spend the token from the emailed link. It arrives in the body, never in a URL or a log line. */
export async function optOutAction(token: string): Promise<OptOutState> {
  try {
    return await reminderOptOut(token);
  } catch {
    return 'error';
  }
}
