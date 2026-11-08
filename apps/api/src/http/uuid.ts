/**
 * A syntactically valid UUID. Route handlers that take an id from the URL check this first, so a
 * malformed id answers exactly as an id nobody holds (a 404 or the route's neutral result) instead
 * of reaching the database as a type error and answering 500.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);
