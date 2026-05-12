export class AppError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found.") {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists.") {
    super(message, 409);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.") {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied.") {
    super(message, 403);
  }
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class ValidationError extends AppError {
  public readonly issues: readonly ValidationIssue[];

  constructor(message = "Validation failed.", issues: readonly ValidationIssue[] = []) {
    super(message, 400);
    this.issues = issues;
  }
}
