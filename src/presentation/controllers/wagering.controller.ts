import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerDto } from '../../application/dto/process-wager.dto';
import { WagerTransactionService } from '../../application/services/wager-transaction.service';
import { MetricsService } from '../metrics/metrics.service';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity';
import { NotFoundError } from '../../application/errors/application-error';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { FailureCode } from '../../domain/wagering/failure-code';

@Controller()
export class WageringController {
  constructor(
    private readonly wagerService: WagerTransactionService,
    private readonly metricsService: MetricsService,
    private readonly em: EntityManager,
  ) {}

  @Post('wagering/transactions')
  public async submitTransaction(
    @Body() dto: ProcessWagerDto,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const idempotencyKey = idempotencyKeyHeader?.trim();
    if (!idempotencyKey) {
      throw new BadRequestException({
        failureCode: FailureCode.IDEMPOTENCY_KEY_REQUIRED,
        message: 'Idempotency-Key header is required',
      });
    }
    if (idempotencyKey.length > 255) {
      throw new BadRequestException({
        failureCode: FailureCode.INVALID_IDEMPOTENCY_KEY,
        message: 'Idempotency-Key must be at most 255 characters',
      });
    }

    const result = await this.wagerService.processTransaction(dto, {
      idempotencyKey,
      correlationId,
    });

    // Record metrics
    this.metricsService.recordTransactionStatus(
      result.status as 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE',
    );
    if (result.idempotentReplay) {
      this.metricsService.recordDuplicateDetected();
    }

    // Map business status to clear HTTP status codes per Section 9
    if (result.status === WagerTransactionStatus.Processed) {
      res.status(HttpStatus.OK).json(result);
    } else if (result.status === WagerTransactionStatus.PendingReference) {
      res.status(HttpStatus.ACCEPTED).json(result);
    } else if (result.status === WagerTransactionStatus.Rejected) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(result);
    } else {
      res.status(HttpStatus.OK).json(result);
    }
  }

  @Get('wagering/transactions/:transactionId')
  public async getTransactionById(@Param('transactionId') transactionId: string) {
    const entity = await this.em.findOne(WagerTransactionEntity, { id: transactionId });
    if (!entity) {
      throw new NotFoundError(`Transaction ${transactionId} not found`);
    }

    return {
      transactionId: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind,
      money: { amount: entity.amount, currency: entity.currency },
      status: entity.status,
      failureCode: entity.failureCode,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      createdAt: entity.createdAt.toISOString(),
      processedAt: entity.processedAt?.toISOString(),
    };
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  public async getTransactionByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const entity = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    if (!entity) {
      throw new NotFoundError(
        `Transaction with external ID ${externalTransactionId} for provider ${providerId} not found`,
      );
    }

    return {
      transactionId: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind,
      money: { amount: entity.amount, currency: entity.currency },
      status: entity.status,
      failureCode: entity.failureCode,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      createdAt: entity.createdAt.toISOString(),
      processedAt: entity.processedAt?.toISOString(),
    };
  }
}
