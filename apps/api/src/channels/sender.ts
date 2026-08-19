/**
 * Sending a message back (MASTER-PLAN §5.3.4).
 *
 * A port, for the same reason the model has one: everything worth testing —
 * that we rehydrate at the last moment and not before, that a send failure
 * does not lose the record, that a stranger gets an answer — is behaviour
 * around the send, and asserting it against Meta's live API would need a real
 * WhatsApp number in CI.
 */
export interface OutboundMessage {
  /** E.164 recipient, as Meta gives it on the inbound message. */
  to: string;
  /**
   * Fully rehydrated. This is the ONLY place in the system where a real
   * customer name is allowed to exist outside the vault, and it exists here
   * for the length of one HTTP request.
   */
  text: string;
}

export interface SendResult {
  /** Meta's `wamid` for the message we sent. */
  providerMessageId: string | null;
}

export interface MessageSender {
  send(message: OutboundMessage): Promise<SendResult>;
}

/** The send failed. The reply is lost; the merchant's record is not. */
export class SendFailed extends Error {
  override readonly name = 'SendFailed';
}
