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

/**
 * Fetching media a merchant sent us.
 *
 * On the sender rather than in its own port because it is the same credential
 * and the same host: splitting it would mean two objects holding one access
 * token. Returns BYTES and never a path — a voice note is the most
 * identifying thing a merchant can send, and the promise is that it lives in
 * memory for one request and nowhere else.
 */
export interface InboundMedia {
  bytes: Buffer;
  mimeType: string;
}

/**
 * A billing notice, sent as a UTILITY TEMPLATE.
 *
 * A merchant whose card just failed has not necessarily messaged the business
 * number in the last 24 hours, so a free-form text is rejected by Meta the
 * same way a sign-in code is (131047). The reminder is exactly the kind of
 * message a utility template exists for: an account event the merchant is
 * already party to.
 *
 * Two parameters, in order: how many days of grace remain, and the date it
 * ends. Enough for the merchant to act, and nothing about what they sell.
 */
export interface OutboundBillingNotice {
  to: string;
  daysLeft: string;
  endsOn: string;
}

/**
 * A retention warning, sent as a UTILITY TEMPLATE.
 *
 * The recipient by definition has not messaged the business number in
 * months - that is what makes them due - so a free-form text is the one thing
 * that cannot reach them.
 *
 * Two parameters: how many days until the records go, and the date. Enough to
 * act on, and nothing about what the business sold.
 */
export interface OutboundRetentionNotice {
  to: string;
  daysLeft: string;
  deletesOn: string;
}

export interface MessageSender {
  send(message: OutboundMessage): Promise<SendResult>;
  /** Download media by Meta's id. Throws `SendFailed` when it cannot. */
  fetchMedia(mediaId: string): Promise<InboundMedia>;
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
  /**
   * A grace-period reminder (ADR 0024).
   *
   * Its own method, like `sendAuthCode`, because it is a template rather than
   * a reply and the difference is not cosmetic: collapsing it into `send`
   * would make the sweep pass every test and reach nobody outside the window.
   */
  sendBillingNotice(notice: OutboundBillingNotice): Promise<SendResult>;
  /**
   * A retention warning (ADR 0024). Its own template, not a reuse of the
   * billing one: Meta approves templates by their text, and one generic
   * enough to carry both messages is one they refuse as free-form.
   */
  sendRetentionNotice(notice: OutboundRetentionNotice): Promise<SendResult>;
}

/** The send failed. The reply is lost; the merchant's record is not. */
export class SendFailed extends Error {
  override readonly name = 'SendFailed';
}
