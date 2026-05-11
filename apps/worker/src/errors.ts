/**
 * Centralized HTTP error type — any route throws, the global onError handles.
 *
 * `status` is locked to a known set so we don't accidentally surface
 * surprising codes to clients. 500 / 503 are included for endpoints that
 * legitimately model dependency failure (e.g. /api/health probing D1+KV).
 * Unexpected throws are caught by the catch-all and don't go through here.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
