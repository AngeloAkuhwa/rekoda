/**
 * The injection token, defined away from the module that provides it.
 *
 * A token in the module means the module imports the service and the service
 * imports the module, and Nest reports that cycle as "argument at index [n] is
 * not available" — which reads like a missing provider rather than an import
 * loop. Learned once already, on MODEL_TRANSPORT.
 */
export const MESSAGE_SENDER = Symbol('MessageSender');
