'use server';

import { revalidatePath } from 'next/cache';
import { saveShop } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface ShopFormState {
  error?: string;
  done?: string;
}

/**
 * Choose the handle and open or close the shop.
 *
 * The WhatsApp number is not on this form on purpose. It is taken from the
 * account, so a merchant cannot publish a number they do not control, and a
 * customer tapping "order" always reaches the person who owns the catalogue.
 */
export async function saveShopAction(
  _prev: ShopFormState,
  formData: FormData,
): Promise<ShopFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const slug = String(formData.get('slug') ?? '')
    .trim()
    .toLowerCase();
  const displayName = String(formData.get('displayName') ?? '').trim();
  const tagline = String(formData.get('tagline') ?? '').trim();
  const published = formData.get('published') === 'yes';

  if (displayName.length < 2) return { error: 'Give the shop a name customers will recognise.' };

  const outcome = await saveShop(token, {
    slug,
    displayName,
    tagline: tagline === '' ? null : tagline,
    published,
  });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'bad_slug') {
    return {
      error:
        'A shop link is lowercase letters, numbers and single hyphens, between 3 and 40 ' +
        'characters. For example ada-fashion.',
    };
  }
  if (outcome.outcome === 'slug_taken') {
    return { error: `Somebody already has ${slug}. Try another one.` };
  }
  /* Publishing an empty page is worse than not publishing: a customer opens
   * it once, finds nothing, and does not come back. */
  if (outcome.outcome === 'nothing_to_sell') {
    return {
      error:
        'Nothing in your catalogue has a price yet, so the shop would open empty. Set a price ' +
        'on at least one product first.',
    };
  }

  revalidatePath('/app/catalogue');
  return {
    done: outcome.published
      ? `Open. Share rekoda.app/s/${outcome.slug} and customers can order from it.`
      : 'Saved and closed. Nobody can see it until you open the shop.',
  };
}
