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

export interface OutboundDocument {
  to: string;
  bytes: Buffer;
  /** What the merchant sees in their chat. `INV-2026-000001.pdf`, not a uuid. */
  filename: string;
  contentType: string;
  /** One line above the attachment. Rehydrated, like any other message text. */
  caption?: string;
}

/**
 * A one-time code, sent as an AUTHENTICATION TEMPLATE.
 *
 * The only sanctioned way to reach a phone that has not messaged the business
 * number in the last 24 hours, which is every phone signing in for the first
 * time. A free-form text to that number is rejected by Meta (131047), so a
 * sign-in built on `send` cannot work in production however well it tests.
 */
export interface OutboundAuthCode {
  to: string;
  /** The code itself. Fills both the body placeholder and the copy button. */
  code: string;
}

export interface MessageSender {
  send(message: OutboundMessage): Promise<SendResult>;
  /**
   * Deliver a one-time code. Separate from `send` for the same reason
   * `sendDocument` is: on Meta it is a different message type under different
   * rules, and hiding that behind `send` is what made sign-in look shipped.
   */
  sendAuthCode(code: OutboundAuthCode): Promise<SendResult>;
  /**
   * Send a file.
   *
   * Separate from `send` because it is genuinely a different operation on
   * Meta's API — an upload that yields a media id, then a message referencing
   * it — and collapsing the two behind one method would hide that a document
   * costs two round trips and can fail halfway.
   */
  sendDocument(document: OutboundDocument): Promise<SendResult>;
}

/** The send failed. The reply is lost; the merchant's record is not. */
export class SendFailed extends Error {
  override readonly name = 'SendFailed';
}
