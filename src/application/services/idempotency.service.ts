import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { ProcessWagerDto } from '../dto/process-wager.dto';

@Injectable()
export class IdempotencyService {
  /**
   * Generates a deterministic SHA-256 hash of the canonical JSON representation
   * of the business fields in a wager transaction.
   */
  public computePayloadHash(dto: ProcessWagerDto): string {
    const canonicalBusinessPayload = {
      externalTransactionId: dto.externalTransactionId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: {
        amount: Number(dto.money.amount).toFixed(2),
        currency: dto.money.currency.trim().toUpperCase(),
      },
      playerId: dto.playerId,
      providerId: dto.providerId,
      referenceExternalTransactionId: dto.referenceExternalTransactionId ?? null,
      roundId: dto.roundId,
      walletId: dto.walletId,
    };

    const canonicalJsonString = this.canonicalStringify(canonicalBusinessPayload);
    return createHash('sha256').update(canonicalJsonString, 'utf8').digest('hex');
  }

  /**
   * Sorts object keys recursively to produce a strictly deterministic JSON string.
   */
  public canonicalStringify(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
      return '[' + obj.map((item) => this.canonicalStringify(item)).join(',') + ']';
    }

    const record = obj as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const entries = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${this.canonicalStringify(record[key])}`,
    );

    return '{' + entries.join(',') + '}';
  }
}
