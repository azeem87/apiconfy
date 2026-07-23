import { describe, it, expect } from 'bun:test';
import { AppError, NotFoundError, ValidationError, BadRequestError, AuthError, ExternalServiceError, TransformationError, WorkflowError } from '@/lib/errors.js';

describe('AppError', () => {
  it('creates error with code and status', () => {
    const err = new AppError('Something failed', 'CUSTOM', 418);
    expect(err.message).toBe('Something failed');
    expect(err.code).toBe('CUSTOM');
    expect(err.statusCode).toBe(418);
    expect(err.name).toBe('AppError');
  });

  it('NotFoundError has correct defaults', () => {
    const err = new NotFoundError('Not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('ValidationError carries details', () => {
    const err = new ValidationError('Invalid', { field: 'name' });
    expect(err.details).toEqual({ field: 'name' });
  });
});

describe('error subclasses', () => {
  it('BadRequestError', () => {
    const err = new BadRequestError('bad');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('BAD_REQUEST');
  });

  it('AuthError', () => {
    const err = new AuthError('unauthorized');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTH_FAILED');
  });

  it('ExternalServiceError', () => {
    const err = new ExternalServiceError('downstream', 503);
    expect(err.statusCode).toBe(502);
    expect(err.upstreamStatusCode).toBe(503);
  });

  it('TransformationError', () => {
    const err = new TransformationError('mapping failed');
    expect(err.code).toBe('TRANSFORMATION_ERROR');
  });

  it('WorkflowError', () => {
    const err = new WorkflowError('step failed');
    expect(err.code).toBe('WORKFLOW_ERROR');
  });
});
