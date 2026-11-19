import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import {
  ConflictError,
  NotFoundError,
  BusinessRejectionError,
} from '../../application/errors/application-error';
import { DomainError, InvalidMoneyError } from '../../domain/common/domain-error';
import { FailureCode } from '../../domain/wagering/failure-code';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();
    const correlationId = request.correlationId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message = 'An unexpected error occurred';
    let failureCode: string | undefined;

    if (exception instanceof NotFoundError) {
      status = HttpStatus.NOT_FOUND;
      error = 'Not Found';
      message = exception.message;
      failureCode = FailureCode.RESOURCE_NOT_FOUND;
    } else if (exception instanceof ConflictError) {
      status = HttpStatus.CONFLICT;
      error = 'Conflict';
      message = exception.message;
      failureCode = exception.failureCode ?? FailureCode.CONFLICT;
    } else if (exception instanceof BusinessRejectionError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      error = 'Business Rule Rejection';
      message = exception.message;
      failureCode = exception.failureCode;
    } else if (exception instanceof InvalidMoneyError) {
      status = HttpStatus.BAD_REQUEST;
      error = 'Invalid Payload';
      message = exception.message;
      failureCode = FailureCode.INVALID_PAYLOAD;
    } else if (exception instanceof DomainError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      error = 'Domain Error';
      message = exception.message;
      failureCode = FailureCode.DOMAIN_RULE_VIOLATION;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        error = (body.error as string) ?? exception.name;
        message = (body.message as string) ?? exception.message;
        failureCode = body.failureCode as string | undefined;
      } else {
        message = String(res);
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled error: ${exception.message}`, exception.stack);
      message = exception.message;
    }

    failureCode ??= status === HttpStatus.BAD_REQUEST
      ? FailureCode.INVALID_PAYLOAD
      : status >= HttpStatus.INTERNAL_SERVER_ERROR
        ? FailureCode.INTERNAL_ERROR
        : undefined;

    response.status(status).json({
      statusCode: status,
      error,
      message,
      failureCode,
      correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
