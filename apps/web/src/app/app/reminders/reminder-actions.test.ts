/**
 * A reminder write whose answer is lost (REM-06).
 *
 * The API may have committed a send or a batch before the connection dropped. If the action threw,
 * the dashboard's error boundary would remount the form, a new idempotency key would be drawn, and
 * the next press could message the customer a second time. The action must instead answer with a
 * sentence and leave the form, and its key, where they are.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  /* As Next does: a redirect is thrown, and it must leave the action untouched. */
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to}` });
  }),
}));
vi.mock('@/server/session-cookies', () => ({ readSessionToken: vi.fn(async () => 'tok') }));
vi.mock('@/server/api', () => {
  class ApiForbidden extends Error {}
  class ApiUnavailable extends Error {}
  class ApiUnexpectedStatus extends Error {
    constructor(path: string, status: number) {
      super(`unexpected ${status} from ${path}`);
    }
  }
  return {
    ApiForbidden,
    ApiUnavailable,
    ApiUnexpectedStatus,
    cancelReminderBatch: vi.fn(),
    clearPaymentInstruction: vi.fn(),
    createReminderBatch: vi.fn(),
    previewReminderBatch: vi.fn(),
    savePaymentInstruction: vi.fn(),
    savePublicContact: vi.fn(),
    sendReminder: vi.fn(),
    setRemindersStopped: vi.fn(),
    /* The real one: a refusal it does not recognise is rethrown. */
    viewOnlyRefusal: vi.fn((error: unknown) => {
      throw error;
    }),
  };
});

const api = await import('@/server/api');
const {
  clearPaymentInstructionAction,
  createBatchAction,
  previewBatchAction,
  savePaymentInstructionAction,
  savePublicContactAction,
  sendReminderAction,
} = await import('./actions');
const sendReminder = vi.mocked(api.sendReminder);
const createReminderBatch = vi.mocked(api.createReminderBatch);
const previewReminderBatch = vi.mocked(api.previewReminderBatch);
const clearPaymentInstruction = vi.mocked(api.clearPaymentInstruction);
const savePaymentInstruction = vi.mocked(api.savePaymentInstruction);
const savePublicContact = vi.mocked(api.savePublicContact);

const INTENT = '6c0e7f1a-2b3d-4c5e-8f90-a1b2c3d4e5f6';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(() => {
  sendReminder.mockReset();
  createReminderBatch.mockReset();
  previewReminderBatch.mockReset();
});

describe('a reminder write whose answer is lost', () => {
  it('a send that may have gone through answers in words and keeps its key for the retry', async () => {
    sendReminder.mockRejectedValue(new api.ApiUnavailable('cannot reach the Rekoda API'));
    const state = await sendReminderAction(
      {},
      form({ invoiceNumber: 'INV-2026-000001', channels: 'whatsapp', idempotencyKey: INTENT }),
    );
    expect(state.error).toMatch(/could not confirm/i);
    expect(state.error).toMatch(/check/i);
    /* Not settled: the form keeps the same key, so a second press replays rather than resends. */
    expect(state.settled).toBeUndefined();
  });

  it('an unexpected API answer to a send is treated the same way', async () => {
    sendReminder.mockRejectedValue(new api.ApiUnexpectedStatus('/v1/reminders', 502));
    const state = await sendReminderAction(
      {},
      form({ invoiceNumber: 'INV-2026-000001', channels: 'whatsapp', idempotencyKey: INTENT }),
    );
    expect(state.error).toMatch(/could not confirm/i);
    expect(state.settled).toBeUndefined();
  });

  it('a batch confirmation that may have gone through answers in words, never a crashed page', async () => {
    createReminderBatch.mockRejectedValue(new api.ApiUnavailable('cannot reach the Rekoda API'));
    const state = await createBatchAction(
      {},
      form({
        invoice: 'INV-2026-000001',
        channels: 'whatsapp',
        when: 'now',
        idempotencyKey: INTENT,
      }),
    );
    expect(state.error).toMatch(/could not confirm/i);
  });

  it('a preview, which writes nothing, says nothing was scheduled', async () => {
    previewReminderBatch.mockRejectedValue(new api.ApiUnavailable('cannot reach the Rekoda API'));
    const state = await previewBatchAction(
      {},
      form({ invoice: 'INV-2026-000001', channels: 'whatsapp', when: 'now' }),
    );
    expect(state.error).toMatch(/nothing was scheduled/i);
    expect(state.error).not.toMatch(/may have/i);
  });

  it('an answer the contract cannot read is treated as unconfirmed, not a crashed page', async () => {
    const parse = Object.assign(new Error('invalid response'), { name: 'ZodError' });
    sendReminder.mockRejectedValue(parse);
    const state = await sendReminderAction(
      {},
      form({ invoiceNumber: 'INV-2026-000001', channels: 'whatsapp', idempotencyKey: INTENT }),
    );
    expect(state.error).toMatch(/could not confirm/i);
    expect(state.settled).toBeUndefined();
  });

  it('a confirmed batch still redirects to its page: the wrapper never swallows a redirect', async () => {
    createReminderBatch.mockResolvedValue({
      state: 'created',
      batch: { id: '11111111-2222-4333-8444-555555555555' },
    } as never);
    await expect(
      createBatchAction(
        {},
        form({
          invoice: 'INV-2026-000001',
          channels: 'whatsapp',
          when: 'now',
          idempotencyKey: INTENT,
        }),
      ),
    ).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') });
  });

  it('a settings removal whose answer is lost asks the owner to check, promising no replay', async () => {
    clearPaymentInstruction.mockRejectedValue(
      new api.ApiUnavailable('cannot reach the Rekoda API'),
    );
    const state = await clearPaymentInstructionAction({}, form({}));
    expect(state.error).toMatch(/check your settings/i);
    expect(state.error).not.toMatch(/never|twice/i);
  });

  it('every settings change whose answer is lost asks the owner to check the settings', async () => {
    savePaymentInstruction.mockRejectedValue(new api.ApiUnavailable('cannot reach the Rekoda API'));
    savePublicContact.mockRejectedValue(new api.ApiUnavailable('cannot reach the Rekoda API'));
    const bank = await savePaymentInstructionAction(
      {},
      form({
        bankName: 'GTBank',
        accountName: 'Ada Stores',
        accountNumber: '0123456789',
        approve: 'yes',
      }),
    );
    const phone = await savePublicContactAction({}, form({ publicPhone: '08031234567' }));
    expect(savePaymentInstruction).toHaveBeenCalledOnce();
    expect(savePublicContact).toHaveBeenCalledOnce();
    expect(bank.error).toMatch(/check your settings/i);
    expect(phone.error).toMatch(/check your settings/i);
  });
});
