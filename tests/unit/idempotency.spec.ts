import { describe, expect, it } from 'bun:test';
import { IdempotencyService } from '../../src/application/services/idempotency.service';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { ProcessWagerDto } from '../../src/application/dto/process-wager.dto';

describe('IdempotencyService', () => {
  const service = new IdempotencyService();

  const baseDto: ProcessWagerDto = {
    providerId: 'provider-a',
    externalTransactionId: 'tx-100',
    playerId: 'p-1',
    walletId: 'w-1',
    roundId: 'r-1',
    gameId: 'fortune-tiger',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('should generate identical hash for identical payloads regardless of property order', () => {
    const hash1 = service.computePayloadHash(baseDto);

    // Permuted property order
    const permutedDto: ProcessWagerDto = {
      kind: WagerTransactionKind.Bet,
      money: { currency: 'BRL', amount: '25.00' },
      gameId: 'fortune-tiger',
      roundId: 'r-1',
      walletId: 'w-1',
      playerId: 'p-1',
      externalTransactionId: 'tx-100',
      providerId: 'provider-a',
    };

    const hash2 = service.computePayloadHash(permutedDto);
    expect(hash1).toBe(hash2);
  });

  it('should generate different hash if any business field changes', () => {
    const hash1 = service.computePayloadHash(baseDto);

    const differentAmountDto: ProcessWagerDto = {
      ...baseDto,
      money: { amount: '30.00', currency: 'BRL' },
    };
    const hash2 = service.computePayloadHash(differentAmountDto);
    expect(hash1).not.toBe(hash2);

    const differentRoundDto: ProcessWagerDto = {
      ...baseDto,
      roundId: 'round-999',
    };
    const hash3 = service.computePayloadHash(differentRoundDto);
    expect(hash1).not.toBe(hash3);
  });

  it('should produce deterministic string for nested objects', () => {
    const obj1 = { b: 2, a: { y: 20, x: 10 } };
    const obj2 = { a: { x: 10, y: 20 }, b: 2 };

    expect(service.canonicalStringify(obj1)).toBe(service.canonicalStringify(obj2));
    expect(service.canonicalStringify(obj1)).toBe('{"a":{"x":10,"y":20},"b":2}');
  });
});
