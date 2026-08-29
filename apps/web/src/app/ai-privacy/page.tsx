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
                The first time you mention a new customer by name, the model reads that one message
                to understand it. The name is then stored encrypted with its own token, nothing
                keeps a readable copy, and every later message that names them is protected before
                it leaves.
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
