/**
 * "my email is accounts@shop.ng" (OWN-83): the owner gives the business email. The whole message
 * must be the command; a sentence that merely contains an address still goes to the model, where
 * the gateway tokenises it. It only starts confirmation: nothing here verifies anything. Split
 * from router.test.ts, which is over the layout limit.
 */
import { describe, expect, it } from 'vitest';
import {
  businessEmailCommand,
  routeMessage,
  staysLocal,
  type DeterministicIntent,
} from './router.js';

function intentOf(message: string): DeterministicIntent | null {
  const route = routeMessage(message);
  return route.route === 'deterministic' ? route.intent : null;
}

const goesToModel = (message: string): boolean => routeMessage(message).route === 'model';

describe('the business email command', () => {
  it.each([
    ['my email is accounts@adaeze.ng', 'accounts@adaeze.ng'],
    ['My business email is Accounts@Adaeze.ng', 'Accounts@Adaeze.ng'],
    ['business email: accounts@adaeze.ng', 'accounts@adaeze.ng'],
    ['email accounts@adaeze.ng', 'accounts@adaeze.ng'],
    ['billing email accounts@adaeze.ng.', 'accounts@adaeze.ng'],
    ['our e-mail address is hello@bisi-shoes.com.ng', 'hello@bisi-shoes.com.ng'],
    ['  my email is accounts@adaeze.ng  ', 'accounts@adaeze.ng'],
  ])('reads %j', (raw, email) => {
    expect(intentOf(raw)).toEqual({ kind: 'business_email', email });
    expect(staysLocal(routeMessage(raw))).toBe(true);
  });

  it.each([
    'send the receipt to ada@customer.ng',
    'Ada bought 3 wigs, her email is ada@customer.ng',
    'my email is',
    'email me the report',
    'my email is not working',
    'my email is a@b.ng and c@d.ng',
    'customer email ada@customer.ng',
  ])('leaves %j to the model', (raw) => {
    expect(goesToModel(raw)).toBe(true);
  });

  it('still lets STOP win', () => {
    expect(intentOf('stop')).toEqual({ kind: 'stop' });
  });

  it('refuses an overlong message outright', () => {
    expect(businessEmailCommand(`my email is ${'a'.repeat(400)}@x.ng`)).toBeNull();
  });
});
