import { SITE_URL } from '@/lib/site';

/**
 * schema.org markup (MASTER-PLAN §5.2.5).
 *
 * Serialised with the `<` escaped: a JSON string containing `</script>` would
 * otherwise close the tag early and put the rest of the payload into the
 * document as markup. That is a real injection route wherever any part of the
 * data is not a compile-time constant, so it is closed here rather than
 * remembered later.
 */
export function StructuredData({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

export const softwareApplicationSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Rekoda',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web, WhatsApp',
  description:
    'A WhatsApp-first financial assistant for Nigerian small businesses. Turns messages and voice notes into invoices, receipts and books you can trust.',
  url: SITE_URL,
  areaServed: { '@type': 'Country', name: 'Nigeria' },
  offers: {
    '@type': 'Offer',
    priceCurrency: 'NGN',
    price: '9900',
    description: 'From ₦9,900 per month after a 30-day free trial. No card needed to start.',
  },
};

export const faqSchema = (
  faqs: ReadonlyArray<{ question: string; answer: string }>,
): Record<string, unknown> => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((faq) => ({
    '@type': 'Question',
    name: faq.question,
    acceptedAnswer: { '@type': 'Answer', text: faq.answer },
  })),
});
