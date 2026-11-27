import { getProgress, listDocuments, reviewValue } from '@lomi/db';
import {
  ReviewInput,
  type DocumentListItemDto,
  type ProgressDto,
  type ReviewResultDto,
} from '@lomi/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { HttpError } from '../errors.js';

const IdParams = z.object({ id: z.uuid() });

/** Registers the list, progress and review routes. */
export function reviewRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * `GET /documents` -> `DocumentListItemDto[]`.
   *
   * - `200`: every document, newest first, with its current version's status and review
   *   progress (an empty array when there are none).
   */
  app.get('/documents', async (): Promise<DocumentListItemDto[]> =>
    listDocuments(deps.db, { fields: deps.fields }),
  );

  /**
   * `GET /documents/:id/progress` -> `ProgressDto` for the current version.
   *
   * - `200`: counts by review state; all zeros while the version has no values yet.
   * - `400 bad_request`: `:id` is not a UUID.
   * - `404 not_found`: no such document.
   */
  app.get('/documents/:id/progress', async (req): Promise<ProgressDto> => {
    const { id } = IdParams.parse(req.params);
    const progress = await getProgress(deps.db, id, { fields: deps.fields });
    if (!progress) throw new HttpError(404, 'not_found', 'document not found');
    return progress;
  });

  /**
   * `POST /values/:id/review` (body `ReviewInput`: `approve`, or `correct` with `value`
   * and an optional `note`) -> `ReviewResultDto`.
   *
   * - `201`: a review row was appended; the body has the value's new state and progress.
   * - `400 bad_request`: `:id` is not a UUID, the body fails `ReviewInput`, or a correction
   *   is not a valid value for the field's type.
   * - `404 not_found`: no such value.
   * - `409 conflict`: the value is not reviewable (its version is not the current one, or
   *   is not `extracted`); the message says which.
   */
  app.post('/values/:id/review', async (req, reply): Promise<ReviewResultDto> => {
    // Validate the id first: a non-UUID reaching Postgres would throw and become a 500.
    const { id } = IdParams.parse(req.params);
    const input = ReviewInput.parse(req.body);
    const result = await reviewValue(deps.db, id, input, { fields: deps.fields });
    switch (result.kind) {
      case 'not_found':
        throw new HttpError(404, 'not_found', 'value not found');
      case 'not_reviewable':
        throw new HttpError(409, 'conflict', result.reason);
      case 'invalid_value':
        throw new HttpError(400, 'bad_request', result.message);
      case 'reviewed':
        return reply.code(201).send(result.result);
    }
  });
}
