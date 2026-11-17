import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CreateWalletDto } from '../../application/dto/create-wallet.dto';
import {
  LedgerPaginationResult,
  ReconciliationResult,
  WalletService,
} from '../../application/services/wallet.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletService: WalletService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async createWallet(@Body() dto: CreateWalletDto) {
    return await this.walletService.openWallet(dto);
  }

  @Get(':walletId')
  public async getWallet(@Param('walletId') walletId: string) {
    return await this.walletService.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  public async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LedgerPaginationResult> {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return await this.walletService.getLedger(walletId, cursor, parsedLimit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  public async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<ReconciliationResult> {
    return await this.walletService.reconcileWallet(walletId);
  }
}
