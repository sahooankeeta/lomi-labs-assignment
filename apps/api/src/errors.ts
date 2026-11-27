import type { ApiError } from '@lomi/shared';

/**
 * An error a route throws on purpose: the central error handler (see `buildApp`) turns it
 * into `status` with body `{ error: code, message }`. Anything else that reaches the
 * handler is treated as unexpected (500 `internal`) and its details are not sent to the client.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiError['error'],
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
