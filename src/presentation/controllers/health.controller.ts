import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { Public } from '../auth/public.decorator';
import { MetricsService } from '../metrics/metrics.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly metricsService: MetricsService,
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
    try {
      // Verify PostgreSQL database connectivity
      await this.em.getConnection().execute('SELECT 1');

      res.status(HttpStatus.OK).json({
        status: 'UP',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'DOWN',
        database: 'disconnected',
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  @Public()
  @Get('metrics')
  public getMetrics(): Record<string, unknown> {
    return this.metricsService.getSnapshot();
  }
}
