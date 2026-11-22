export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }

  toResponse() {
    return Response.json(
      { detail: this.message, code: this.code },
      { status: this.status, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export class UniqueConflict extends Error {
  constructor() {
    super('unique constraint conflict');
    this.name = 'UniqueConflict';
  }
}

export function fail(code, message, status = 400) {
  throw new AppError(code, message, status);
}
