'use server';

import { revalidatePath } from 'next/cache';
import { parseAmountText, toKobo } from '@rekoda/core';
import { createProduct, editProduct, uploadProductImage, viewOnlyRefusal } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface CatalogueFormState {
  error?: string;
  done?: string;
}

/**
 * One field per form, on purpose.
 *
 * A single "edit this product" form would have to post every field it knows
 * about, and an empty description box would then clear a description every
 * time somebody set a price. The API distinguishes ABSENT from null exactly
 * so that cannot happen, and a form that always sends everything throws that
 * away. Separate forms mean an empty box has one meaning: clear this.
 */
async function change(
  edit: Parameters<typeof editProduct>[1],
  done: string,
): Promise<CatalogueFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const outcome = await editProduct(token, edit);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };
  if (outcome.outcome === 'not_found') return { error: 'That product is no longer here.' };
  if (outcome.outcome === 'nothing_to_do') return { error: 'Nothing to change there.' };

  revalidatePath('/app/catalogue');
  return { done };
}

/**
 * What it sells for.
 *
 * Typed in NAIRA, because that is what a person says, and converted once by
 * `toKobo`, which asserts the result is a whole number of kobo. Nothing in
 * this file does arithmetic on money.
 */
async function setPriceActionUnguarded(
  _prev: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Pick a product.' };

  const naira = parseAmountText(String(formData.get('price') ?? ''));
  if (naira === null || naira <= 0) {
    return { error: 'Say the price in naira. For example 8500, or 8.5k.' };
  }
  return change({ id, unitPriceK: toKobo(naira) }, 'Price saved.');
}

/**
 * What it cost them, stated rather than derived.
 *
 * Normally a delivery moves this: "bought 10 bags of rice for 45k" is a
 * quantity and an amount, and the average follows. This is for the stock a
 * merchant counted by hand or bought before they joined, which otherwise
 * sells with no cost against it forever and quietly overstates every profit
 * figure they read.
 *
 * A stated cost REPLACES the average rather than averaging into it. The
 * merchant is correcting or supplying the figure, and blending their answer
 * with the history they are correcting would give them neither.
 */
async function setCostActionUnguarded(
  _prev: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Pick a product.' };

  const naira = parseAmountText(String(formData.get('cost') ?? ''));
  if (naira === null || naira <= 0) {
    return { error: 'Say what one costs you, in naira. For example 4500, or 4.5k.' };
  }
  return change(
    { id, unitCostK: toKobo(naira) },
    'Cost saved. Sales of it will now show what the goods cost.',
  );
}

/** What the merchant would say about it. An empty box clears it. */
async function setDescriptionActionUnguarded(
  _prev: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Pick a product.' };

  const description = String(formData.get('description') ?? '').trim();
  if (description.length > 400) return { error: 'Keep it under 400 characters.' };

  return change(
    { id, description: description === '' ? null : description },
    description === '' ? 'Description cleared.' : 'Description saved.',
  );
}

/** List a product in the shop, or take it out of it. */
async function setProductListedActionUnguarded(
  _prev: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Pick a product.' };
  const active = formData.get('active') === 'list';

  /* The shelf line is not a footnote. A merchant who hides a product and
   * assumes it left their count would be trading on a number nobody took. */
  return change(
    { id, active },
    active
      ? 'Listed. Customers can see it again.'
      : 'Hidden. It stays in your books and on your shelf, and customers stop seeing it.',
  );
}

/** Attach a photo. Every refusal is a sentence, including the size one. */
async function uploadProductImageActionUnguarded(
  _prev: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const id = String(formData.get('id') ?? '').trim();
  const file = formData.get('photo');
  if (!id) return { error: 'Pick a product.' };
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a photo first.' };

  const outcome = await uploadProductImage(token, id, file);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.outcome === 'not_found') return { error: 'That product is no longer here.' };
  if (outcome.outcome === 'not_an_image') {
    return {
      error:
        'That file is not a photo Rekoda can use. Send a JPEG, PNG or WEBP, straight from your ' +
        'phone camera or gallery.',
    };
  }
  if (outcome.outcome === 'too_large') {
    return {
      error: `That photo is too big. The most Rekoda takes is ${megabytes(outcome.maxBytes)}.`,
    };
  }
  if (outcome.outcome === 'no_storage') {
    return {
      error:
        'Photos are not switched on for this shop yet. Nothing else about the product changed.',
    };
  }

  revalidatePath('/app/catalogue');
  return { done: 'Photo saved.' };
}

/** `2 MB`, from a byte count, so the sentence uses the number a phone shows. */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/* Role refusals (403) come back as a sentence in the form, not a crash.
 * Everything else still throws to the error boundary. */

export async function setPriceAction(
  ...args: Parameters<typeof setPriceActionUnguarded>
): ReturnType<typeof setPriceActionUnguarded> {
  try {
    return await setPriceActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof setPriceActionUnguarded>>;
  }
}

export async function setCostAction(
  ...args: Parameters<typeof setCostActionUnguarded>
): ReturnType<typeof setCostActionUnguarded> {
  try {
    return await setCostActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof setCostActionUnguarded>>;
  }
}

export async function setDescriptionAction(
  ...args: Parameters<typeof setDescriptionActionUnguarded>
): ReturnType<typeof setDescriptionActionUnguarded> {
  try {
    return await setDescriptionActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof setDescriptionActionUnguarded>>;
  }
}

export async function setProductListedAction(
  ...args: Parameters<typeof setProductListedActionUnguarded>
): ReturnType<typeof setProductListedActionUnguarded> {
  try {
    return await setProductListedActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof setProductListedActionUnguarded>>;
  }
}

export async function uploadProductImageAction(
  ...args: Parameters<typeof uploadProductImageActionUnguarded>
): ReturnType<typeof uploadProductImageActionUnguarded> {
  try {
    return await uploadProductImageActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof uploadProductImageActionUnguarded>>;
  }
}

/** A new product, from the page that sells them (fix-plan 5, H2c). */
async function createProductActionUnguarded(
  _prev: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const name = String(formData.get('name') ?? '').trim();
  if (name.length < 2 || name.length > 80) {
    return { error: 'Give it a name of 2 to 80 characters.' };
  }
  const priceText = String(formData.get('price') ?? '').trim();
  const naira = priceText === '' ? undefined : parseAmountText(priceText);
  if (naira === null || (naira !== undefined && naira <= 0)) {
    return { error: 'Say the price in naira, or leave it empty to price it later.' };
  }

  const outcome = await createProduct(token, {
    name,
    ...(naira === undefined ? {} : { unitPriceK: toKobo(naira) }),
  });
  if (!outcome) return { error: 'That did not go through. Nothing was created.' };
  if (outcome.outcome === 'already_exists') {
    return {
      error: `You already have ${outcome.name}. Edit it below rather than keeping two of it.`,
    };
  }

  revalidatePath('/app/catalogue');
  return { done: `${outcome.name} is in your catalogue. Set a cost when you know one.` };
}

/** Fix a typo in a name without splitting the product's history. */
async function renameProductActionUnguarded(
  _prev: CatalogueFormState,
  formData: FormData,
): Promise<CatalogueFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Pick a product.' };
  const name = String(formData.get('name') ?? '').trim();
  if (name.length < 2 || name.length > 80) {
    return { error: 'Give it a name of 2 to 80 characters.' };
  }

  const outcome = await editProduct(token, { id, name });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };
  if (outcome.outcome === 'not_found') return { error: 'That product is no longer here.' };
  if (outcome.outcome === 'name_taken') {
    return {
      error:
        'Another product already answers to that name. Two products a customer cannot tell ' +
        'apart would split your stock history, so nothing was changed.',
    };
  }

  revalidatePath('/app/catalogue');
  return { done: `Renamed to ${name}. Its history and count come along with it.` };
}

export async function createProductAction(
  ...args: Parameters<typeof createProductActionUnguarded>
): ReturnType<typeof createProductActionUnguarded> {
  try {
    return await createProductActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof createProductActionUnguarded>>;
  }
}

export async function renameProductAction(
  ...args: Parameters<typeof renameProductActionUnguarded>
): ReturnType<typeof renameProductActionUnguarded> {
  try {
    return await renameProductActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof renameProductActionUnguarded>>;
  }
}
