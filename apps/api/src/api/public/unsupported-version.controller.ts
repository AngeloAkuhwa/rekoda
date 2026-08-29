/**
 * What `/api/anything-else` answers (canonical spec §27).
 *
 * Without this, a client that typos `/api/v2/identity` gets Nest's bare 404
 * and cannot tell "that version does not exist" from "that route does not
 * exist" — the difference between an upgrade they are not ready for and a
 * typo. Fastify's router prefers static routes over this wildcard whatever
 * the registration order, so a real v1 route is never shadowed by it.
 *
 * No guard: an unknown version must answer the same to everybody, and
 * demanding a valid credential before saying "that version is not served"
 * would make the answer depend on something unrelated to the question.
 */
import { All, Controller, Req, Res, UseFilters } from '@nestjs/common';
import { publicApi } from '@rekoda/contracts';
import { PublicApiExceptionFilter } from './public-api.filter.js';

/** The two methods this needs of a Fastify reply, and nothing else. */
interface JsonReply {
  code(status: number): JsonReply;
  send(body: unknown): unknown;
}

@Controller('api')
@UseFilters(PublicApiExceptionFilter)
export class UnsupportedVersionController {
  /* A bare `*`, not a named parameter: Fastify's router requires the
   * wildcard to be the last character of the path it registers. */
  @All('*')
  refuse(@Req() request: { url?: string }, @Res() reply: JsonReply): void {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const version = path.split('/')[2] ?? '';
    /* A served version reaching here means the version is fine and the
     * route is not, and saying `unsupported_version` would send a developer
     * to look for a release note that does not exist. */
    const known = publicApi.isPublicApiVersion(version);
    const body = publicApi.v1.publicErrorResponse.parse({
      error: known
        ? { code: 'not_found', message: 'no such route in this version' }
        : {
            code: 'unsupported_version',
            message: `this API serves ${publicApi.PUBLIC_API_VERSIONS.join(', ')}`,
          },
    });
    reply.code(404).send(body);
  }
}
