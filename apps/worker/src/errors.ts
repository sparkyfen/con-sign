/** Centralized HTTP error type — any route can throw, the global onError handles. */
export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
