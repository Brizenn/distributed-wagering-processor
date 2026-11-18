import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { Public } from '../auth/public.decorator';
import { MetricsService } from '../metrics/metrics.service';
import { SqsService } from '../../infrastructure/messaging/sqs.client';

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly metricsService: MetricsService,
    private readonly sqsService: SqsService,
  ) {}

  @Public()
  @Get('live')
  public getLive(): { status: string; uptime: number; timestamp: string } {
    return {
      status: 'UP',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('ready')
  public async getReady(@Res() res: Response): Promise<void> {
    const [databaseResult, sqsResult] = await Promise.allSettled([
      this.em.getConnection().execute('SELECT 1'),
      this.sqsService.checkReady(),
    ]);
    const database = databaseResult.status === 'fulfilled' ? 'connected' : 'unavailable';
    const sqs = sqsResult.status === 'fulfilled' ? 'connected' : 'unavailable';
    const ready = database === 'connected' && sqs === 'connected';

    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ready ? 'UP' : 'DOWN',
      database,
      sqs,
      timestamp: new Date().toISOString(),
    });
  }

  @Public()
  @Get('metrics')
  public async getMetrics(): Promise<Record<string, unknown>> {
    try {
      this.metricsService.setDlqMessageCount(
        await this.sqsService.getDlqApproximateMessageCount(),
      );
    } catch {
      // Keep the last known gauge if SQS is temporarily unreachable.
    }
    return this.metricsService.getSnapshot();
  }
}
