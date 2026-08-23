import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { canonical } from '@/lib/site';

export const metadata: Metadata = {
  title: 'AI & privacy',
  description:
    'What Rekoda sends to an AI model and what it never sends: customer names and numbers are replaced with tokens before any message leaves, and money is never computed by a model.',
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
          heading: 'Customer identities are replaced before anything is sent',
          body: (
            <>
              <p>
                Phone numbers, emails and bank details are swapped for meaningless tokens before a
                message reaches any AI provider, and so is every customer name Rekoda already knows.
                The model sees <code>CUSTOMER_7</code>, not Ada, and not her number. The real values
                stay in an encrypted store that the model layer cannot read.
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
          heading: 'Voice notes are transcribed by us',
          body: (
            <p>
              Speech becomes text on infrastructure we run, not by shipping your audio to a
              third-party provider. If that ever has to change for accuracy reasons, this page
              changes first, and it will say which provider and what they receive.
            </p>
          ),
        },
        {
          id: 'receipts',
          heading: 'A photo of a receipt is read by us, not sent onward',
          body: (
            <>
              <p>
                When you photograph a receipt, the picture goes to our own text reader and to
                nowhere else. What the AI sees is the text that came out of it, with names, phone
                numbers and addresses already replaced by tokens, exactly as a typed message is.
              </p>
              <p>
                There is no fallback. If our reader is busy or cannot make out the page, we tell you
                and ask you to type the amount. We do not send the picture to an AI provider
                instead, because a photograph cannot be tokenised: everything on it would arrive
                intact.
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
