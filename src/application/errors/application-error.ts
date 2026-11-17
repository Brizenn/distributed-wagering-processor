export class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class NotFoundError extends ApplicationError {}
export class ConflictError extends ApplicationError {}
export class BusinessRejectionError extends ApplicationError {
  constructor(
    message: string,
    public readonly failureCode: string,
  ) {
    super(message);
  }
}
