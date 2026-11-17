import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { randomUUID } from 'crypto';
import { MetricsService } from '../metrics/metrics.service';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const correlationId = request.headers['x-correlation-id'] || randomUUID();
    request.correlationId = correlationId;

    const startTime = Date.now();
    const { method, url, body } = request;

    // Extract business context without logging sensitive/full payloads
    const providerId = body?.providerId || request.headers['x-provider-id'];
    const walletId = body?.walletId || request.params?.walletId;
    const externalTransactionId = body?.externalTransactionId;

    return next.handle().pipe(
      tap({
        next: (responseBody) => {
          const durationMs = Date.now() - startTime;
          this.metricsService.recordLatency(durationMs);

          const transactionId = responseBody?.transactionId;
          const status = responseBody?.status;

          const logEntry = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            correlationId,
            method,
            path: url,
            durationMs,
            providerId,
            walletId,
            externalTransactionId,
            transactionId,
            status,
          };

          // Safe structured JSON log output
          console.log(JSON.stringify(logEntry));
        },
        error: (err) => {
          const durationMs = Date.now() - startTime;
          const logEntry = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            correlationId,
            method,
            path: url,
            durationMs,
            providerId,
            walletId,
            errorMessage: err.message,
            errorName: err.name,
          };
          console.error(JSON.stringify(logEntry));
        },
      }),
    );
  }
}
