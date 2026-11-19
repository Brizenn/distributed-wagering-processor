import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionService } from '../src/application/services/wager-transaction.service';
import { IdempotencyService } from '../src/application/services/idempotency.service';
import { MetricsService } from '../src/observability/metrics.service';
import databaseConfig from '../src/infrastructure/database/mikro-orm.config';
import { ProcessWagerDto } from '../src/application/dto/process-wager.dto';

interface WorkerRequest {
  dto: ProcessWagerDto;
  idempotencyKey: string;
  count: number;
}

async function run(): Promise<void> {
  const serializedRequest = process.argv[2];
  if (!serializedRequest) throw new Error('Worker request JSON argument is required');
  const request = JSON.parse(serializedRequest) as WorkerRequest;
  const orm = await MikroORM.init(databaseConfig);
  try {
    const results = [];
    // Bound each process's open SQL transactions while all three processes race together.
    for (let offset = 0; offset < request.count; offset += 3) {
      const batchSize = Math.min(3, request.count - offset);
      const batch = await Promise.all(Array.from({ length: batchSize }, () =>
        new WagerTransactionService(
          orm.em.fork(),
          new IdempotencyService(),
          new MetricsService(),
        ).processTransaction(request.dto, { idempotencyKey: request.idempotencyKey }),
      ));
      results.push(...batch);
    }
    console.log(JSON.stringify(results));
  } finally {
    await orm.close(true);
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
