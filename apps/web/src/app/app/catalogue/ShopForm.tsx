'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { saveShopAction, type ShopFormState } from './shop-actions';

export interface ShopState {
  slug: string;
  displayName: string;
  tagline: string | null;
  published: boolean;
}

/**
 * Choosing a handle and switching the shop on.
 *
 * Publishing is a checkbox rather than a second button, because taking a shop
 * DOWN has to be as easy as putting it up: a merchant who needs to stop
 * selling for a week should not have to look for a different control from the
 * one they used to start.
 *
 * The hint on that control earns its place. Open shops go into the sitemap,
 * which means Rekoda publishes a list of them, and a merchant reading "open
 * to customers" would reasonably picture only the people they send the link
 * to. Saying it here is cheaper than being asked afterwards why a competitor
 * found their page.
 */
export function ShopForm({
  current,
  suggestedSlug,
}: {
  current: ShopState | null;
  suggestedSlug: string;
}) {
  const [state, action, pending] = useActionState<ShopFormState, FormData>(saveShopAction, {});

  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="slug"
        label="Your shop link"
        hint="rekoda.app/s/your-handle. Lowercase letters, numbers and hyphens"
        error={state.error}
      >
        <input
          name="slug"
          id="slug"
          required
          minLength={3}
          maxLength={40}
          className="rk-input"
          defaultValue={current?.slug ?? suggestedSlug}
          placeholder="ada-fashion"
        />
      </Field>

      <Field id="displayName" label="Shop name" hint="What customers should see at the top">
        <input
          name="displayName"
          id="displayName"
          required
          minLength={2}
          maxLength={60}
          className="rk-input"
          defaultValue={current?.displayName ?? ''}
        />
      </Field>

      <Field id="tagline" label="One line about the shop" hint="Optional. Your words">
        <input
          name="tagline"
          id="tagline"
          maxLength={120}
          className="rk-input"
          defaultValue={current?.tagline ?? ''}
          placeholder="Wax print by the bale"
        />
      </Field>

      <Field
        id="published"
        label="Open to customers"
        hint="An open shop can be found by search engines, and is listed on rekoda.app"
      >
        <select
          name="published"
          id="published"
          className="rk-input"
          defaultValue={current?.published ? 'yes' : 'no'}
        >
          <option value="no">Keep it closed for now</option>
          <option value="yes">Open the shop</option>
        </select>
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving' : 'Save shop'}
      </Button>
    </form>
  );
}
