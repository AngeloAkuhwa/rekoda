/** G-58: the unconfigured sender is told which setting is actually missing. */
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../config.js';
import { missingSenderSettings } from './replies.module.js';

const config = (metaAccessToken: string, metaPhoneNumberId: string) =>
  ({ metaAccessToken, metaPhoneNumberId }) as ApiConfig;

describe('missingSenderSettings', () => {
  it('names only the phone number id when the token is set', () => {
    expect(missingSenderSettings(config('token', ''))).toEqual(['META_PHONE_NUMBER_ID']);
  });

  it('names only the token when the phone number id is set', () => {
    expect(missingSenderSettings(config('', 'pnid'))).toEqual(['META_ACCESS_TOKEN']);
  });

  it('names both when both are blank, and none when both are set', () => {
    expect(missingSenderSettings(config('', ''))).toEqual([
      'META_ACCESS_TOKEN',
      'META_PHONE_NUMBER_ID',
    ]);
    expect(missingSenderSettings(config('token', 'pnid'))).toEqual([]);
  });
});
