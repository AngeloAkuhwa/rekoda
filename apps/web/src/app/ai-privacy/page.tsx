import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { canonical } from '@/lib/site';

export const metadata: Metadata = {
  title: 'AI & privacy',
  description:
    'What Rekoda sends to each AI processor and what it never sends: supported customer identifiers are tokenised before any model reasons about your business, and money is never computed by a model.',
  alternates: { canonical: canonical('/ai-privacy') },
};

export default function AiPrivacyPage() {
  return (
    <LegalPage
      title="AI & privacy"
      intro="Rekoda uses AI to understand what you say. It does not use AI to decide what your money did. That distinction is the whole design."
      sections={[
        {
          id: 'arithmetic',
          heading: 'No model ever calculates your money',
          body: (
            <>
              <p>
                A language model reads your message and proposes what it thinks happened: three
                wigs, fifty thousand each, part paid. Every figure after that is computed by
                ordinary, tested code, in whole kobo.
              </p>
              <p>
                This matters because models are confident when they are wrong. Rekoda&rsquo;s
                arithmetic is the kind you could check with a calculator, and the same code produces
                the number on your screen and the number on your invoice, so the two can never
                disagree.
              </p>
            </>
          ),
        },
        {
          id: 'tokenisation',
          heading:
            'Supported customer identifiers are replaced before any AI reasons about your business',
          body: (
            <>
              <p>
                Rekoda detects and tokenises supported personal identifiers before text reaches the
                AI that does your bookkeeping: recognised customer names, phone numbers, email
                addresses and supported financial identifiers are swapped for meaningless tokens.
                The model sees <code>CUSTOMER_7</code>, not Ada, and not her number. The real values
                stay in an encrypted store that the model layer cannot read. This is a precise
                promise about those supported identifiers, not a claim that every possible piece of
                personal information in free text is always detected: something unusual you type
                into a message, such as a full street address in an unexpected format, may reach the
                model as written.
              </p>
              <p>
                One step works on raw material and cannot be tokenised first: turning a voice note
                or a photographed receipt into text. A recording is sound and a photograph is
                pixels, and whatever is spoken or printed in them reaches the transcription
                processor as it is. The two sections below name those processors and exactly what
                they are allowed to do; the text they return is tokenised like any typed message
                before the bookkeeping AI reads it.
              </p>
              <p>
                <strong>Customers you have recorded.</strong> Their names, phone numbers and email
                addresses are replaced with a token before a message is sent to the model, in
                questions and in records alike.
              </p>
              <p>
                <strong>Someone new.</strong> When you record a sale, invoice, payment or order for
                someone you have not recorded before, the model reads that message to understand it,
                and Rekoda then stores the new customer encrypted with their own token, so later
                messages that name them are protected before they leave. When you only ask about
                someone you have not recorded, Rekoda does not create a customer for them, so the
                model reads the name you typed each time you ask. That name goes only to the
                bookkeeping model, under the same terms as every other message.
              </p>
              <p>
                <strong>Phone numbers and email addresses.</strong> One that Rekoda detects is
                replaced with a token before the model sees it, whether or not you have recorded
                that person. It becomes a customer only when it is the customer of a sale, invoice,
                payment or order, or when Rekoda asks you in the preview whether it belongs to the
                customer you named. Anywhere else in a record, such as a plumber&rsquo;s number in
                an expense, it is saved as &ldquo;[phone]&rdquo; or &ldquo;[email]&rdquo;, not as
                the number.
              </p>
              <p>
                <strong>What the chat history keeps.</strong> For your messages and Rekoda&rsquo;s
                replies, it records that a message was sent and what kind it was, not what it said.
                A document Rekoda sends you is recorded by its number and amount. Messages from
                before this change can still hold their text until you send{' '}
                <strong>DELETE MY DATA</strong> or your account is deleted.
              </p>
              <p>
                <strong>The original WhatsApp message.</strong> It is kept encrypted, separately
                from the chat history, and is not yet deleted on a fixed schedule. When you send{' '}
                <strong>DELETE MY DATA</strong> and confirm, the originals of the messages Rekoda
                has finished processing are erased along with your customers&rsquo; details.
                Messages still being processed at that moment, delivery receipts and your books are
                kept. A message delivered before this change in the same batch as another
                business&rsquo;s message can still have an encrypted copy stored with that other
                business&rsquo;s message.
              </p>
              <p>
                The substitution runs on the way out and is reversed on the way back, so your
                receipt says Ada while the provider only ever saw a token.
              </p>
            </>
          ),
        },
        {
          id: 'voice',
          heading: 'How a voice note becomes text',
          body: (
            <>
              <p>
                Your audio is sent to OpenAI, a transcription processor, for one purpose only: to
                come back as the sentence you spoke. Under the API terms we use, what we send is not
                used to train their models. The sentence is then treated exactly like a typed
                message: recognised customer names, phone numbers and other supported identifiers
                are replaced by tokens before any AI reasons about it, and we do not keep the audio.
              </p>
              <p>
                An earlier version of this page said transcription ran only on infrastructure we
                run, and promised that if that changed, this page would change first and name the
                provider. This is that change, kept in those words: OpenAI is the transcription
                processor, it is the only one, and there is no automatic switching to anywhere else.
                If voice transcription is switched off for a deployment, voice notes are answered
                with an honest sentence and the audio is sent nowhere at all.
              </p>
            </>
          ),
        },
        {
          id: 'receipts',
          heading: 'How a photographed receipt is read',
          body: (
            <>
              <p>
                The picture is sent to Anthropic with a single instruction: transcribe what the
                paper says, word for word, and nothing else. Under the API terms we use, what we
                send is not used to train their models, and we do not keep the picture. The AI that
                does your bookkeeping never sees it: it sees the transcribed text, with recognised
                customer names, phone numbers and other supported identifiers already replaced by
                tokens, exactly as a typed message is.
              </p>
              <p>
                There is no quiet rerouting. If the reader is busy or cannot make out the page, we
                tell you and ask you to type the amount, rather than trying somewhere else you were
                never told about. Anthropic is the document reader, it is the only one, and which
                features are on is fixed when the system starts, never chosen per message.
              </p>
            </>
          ),
        },
        {
          id: 'training',
          heading: 'Your business is not training data',
          body: (
            <p>
              Nothing you send is used to train a model, ours or anyone else&rsquo;s. If we ever
              want to improve accuracy using real examples, we will ask for that specific
              permission, separately, and it will be genuinely optional.
            </p>
          ),
        },
        {
          id: 'confirm',
          heading: 'Nothing is recorded until you say so',
          body: (
            <p>
              Rekoda shows you what it understood and waits. Where it is unsure it says so plainly
              rather than guessing quietly, and an unclear message becomes a question, not an entry
              in your books.
            </p>
          ),
        },
      ]}
    />
  );
}
