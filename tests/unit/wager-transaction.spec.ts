import { describe, expect, it } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';
import { Money } from '../../src/domain/common/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { DomainError, InvalidTransactionStateError } from '../../src/domain/common/domain-error';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';

describe('WagerTransaction Entity', () => {
  const baseProps = {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-123',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'r-1',
    gameId: 'g-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
  };

  it('should create transaction in PENDING status', () => {
    const tx = WagerTransaction.create(baseProps);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
  });

  it('should require referenceExternalTransactionId for REFUND and ROLLBACK', () => {
    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: undefined,
      }),
    ).toThrow(DomainError);

    expect(() =>
      WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: undefined,
      }),
    ).toThrow(DomainError);

    const validRefund = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-ref-1',
    });
    expect(validRefund.requiresReference()).toBe(true);
  });

  it('should correctly report affectsBalance for LOSS as false', () => {
    const loss = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Loss,
      money: Money.zero('BRL'),
    });
    expect(loss.affectsBalance()).toBe(false);
  });

  it('should transition to PROCESSED and become terminal', () => {
    const tx = WagerTransaction.create(baseProps);
    tx.markProcessed(undefined);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toBeDefined();

    // Any further transition must throw
    expect(() => tx.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed()).toThrow(InvalidTransactionStateError);
  });

  it('should transition to REJECTED and become terminal', () => {
    const tx = WagerTransaction.create(baseProps);
    tx.reject(FailureCode.INSUFFICIENT_FUNDS);

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.isTerminal()).toBe(true);

    expect(() => tx.markProcessed()).toThrow(InvalidTransactionStateError);
  });

  it('should transition to PENDING_REFERENCE and allow subsequent transition', () => {
    const tx = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-ref-1',
    });
    tx.markPendingReference();

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);

    // Can transition to PROCESSED after reference arrives
    tx.markProcessed('internal-ref-id');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('internal-ref-id');
  });

  it('should determine ledger direction correctly for BET, WIN, REFUND and ROLLBACK', () => {
    const bet = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Bet });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);

    const win = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Win });
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    const refund = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ref-1',
    });
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    // Rollback of BET (Debit) -> Credit
    const rollbackBet = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ref-1',
    });
    expect(rollbackBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    // Rollback of WIN (Credit) -> Debit
    const rollbackWin = WagerTransaction.create({
      ...baseProps,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ref-2',
    });
    expect(rollbackWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });
});
