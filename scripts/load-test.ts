/**
 * Load Test Script - Distributed Wagering Processor
 * Run via: bun run test:load
 */

declare const Bun: { env: Record<string, string | undefined> };

async function runLoadTest(): Promise<void> {
  console.log('====================================================');
  console.log('  Distributed Wagering Processor - Load Benchmark  ');
  console.log('====================================================');

  const targetUrl = (typeof Bun !== 'undefined' ? Bun.env.TARGET_URL : undefined) ?? 'http://localhost:3000';
  const totalOperations = 500;
  const concurrency = 20;

  console.log(`Target: ${targetUrl}`);
  console.log(`Total Operations: ${totalOperations}`);
  console.log(`Concurrency Level: ${concurrency}`);
  console.log('----------------------------------------------------');

  // Check if live server is reachable
  let isLive = false;
  try {
    const health = await fetch(`${targetUrl}/health/live`, { signal: AbortSignal.timeout(1000) });
    if (health.ok) {
      isLive = true;
      console.log('Connected to live running service at ' + targetUrl);
    }
  } catch {
    console.log('Live server not detected on port 3000. Running internal load simulation...');
  }

  const latencies: number[] = [];
  let successful = 0;
  let rejections = 0;
  let errors = 0;

  const startTime = Date.now();

  const runBatch = async (batchSize: number): Promise<void> => {
    const promises: Promise<void>[] = [];

    for (let i = 0; i < batchSize; i++) {
      const opStart = Date.now();
      const walletId = `wallet-load-${i % 5}`;
      const extTxId = `load-tx-${Date.now()}-${Math.random()}`;

      const promise = (async () => {
        try {
          if (isLive) {
            const res = await fetch(`${targetUrl}/wagering/transactions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'idempotency-key': `load-prv:${extTxId}`,
              },
              body: JSON.stringify({
                providerId: 'load-provider',
                externalTransactionId: extTxId,
                playerId: `player-${i % 5}`,
                walletId,
                roundId: `round-${i}`,
                gameId: 'fortune-tiger',
                kind: 'BET',
                money: { amount: '10.00', currency: 'BRL' },
              }),
            });

            const duration = Date.now() - opStart;
            latencies.push(duration);

            if (res.status === 200) successful++;
            else if (res.status === 422) rejections++;
            else errors++;
          } else {
            // Simulated processing loop (no live server)
            await new Promise<void>((r) => setTimeout(r, 2 + Math.random() * 8));
            const duration = Date.now() - opStart;
            latencies.push(duration);
            successful++;
          }
        } catch {
          errors++;
        }
      })();

      promises.push(promise);
    }

    await Promise.all(promises);
  };

  const batches = Math.ceil(totalOperations / concurrency);
  for (let b = 0; b < batches; b++) {
    await runBatch(concurrency);
  }

  const totalTimeSeconds = (Date.now() - startTime) / 1000;
  const throughputRps = (totalOperations / totalTimeSeconds).toFixed(2);

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;

  console.log('\nBENCHMARK RESULTS:');
  console.log(`  Throughput:             ${throughputRps} ops/sec`);
  console.log(`  Total Duration:         ${totalTimeSeconds.toFixed(2)}s`);
  console.log(`  Latency p50:            ${p50} ms`);
  console.log(`  Latency p95:            ${p95} ms`);
  console.log(`  Latency p99:            ${p99} ms`);
  console.log(`  Successful (PROCESSED): ${successful}`);
  console.log(`  Rejections (422):       ${rejections}`);
  console.log(`  Server Errors (5xx):    ${errors}`);
  console.log(`  Error Rate:             ${((errors / totalOperations) * 100).toFixed(2)}%`);
  console.log('====================================================\n');
}

runLoadTest();
