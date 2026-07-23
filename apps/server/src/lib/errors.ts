export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BAD_REQUEST', 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_FAILED', 400, details);
  }
}

export class AuthError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTH_FAILED', 401, details);
  }
}

export class ExternalServiceError extends AppError {
  constructor(
    message: string,
    public upstreamStatusCode?: number,
    details?: Record<string, unknown>
  ) {
    super(message, 'EXTERNAL_SERVICE_ERROR', 502, details);
  }
}

export class TransformationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TRANSFORMATION_ERROR', 500, details);
  }
}

export class WorkflowError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'WORKFLOW_ERROR', 500, details);
  }
}
