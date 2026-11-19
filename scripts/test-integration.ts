async function runIntegrationTests(): Promise<void> {
  process.env.RUN_INTEGRATION_TESTS = '1';
  process.env.DB_HOST = process.env.DB_TEST_HOST || 'localhost';
  process.env.DB_PORT = process.env.DB_TEST_PORT || '5433';
  process.env.DB_USER = process.env.DB_TEST_USER || 'wagering_test_user';
  process.env.DB_PASSWORD = process.env.DB_TEST_PASSWORD || 'wagering_test_pass';
  process.env.DB_NAME = process.env.DB_TEST_NAME || 'wagering_test_db';
  const awsEndpoint = process.env.AWS_TEST_ENDPOINT || 'http://localhost:4567';
  process.env.AWS_ENDPOINT = awsEndpoint;
  const queueBaseUrl = `${awsEndpoint.replace(/\/$/, '')}/000000000000`;
  process.env.SQS_MAIN_QUEUE_URL = `${queueBaseUrl}/wager-transactions.fifo`;
  process.env.SQS_DLQ_URL = `${queueBaseUrl}/wager-transactions-dlq.fifo`;
  process.env.SQS_OUTBOX_QUEUE_URL = `${queueBaseUrl}/wager-events.fifo`;

  const testProcess = Bun.spawn(['bun', 'test', 'tests/integration'], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env } as Record<string, string>,
  });

  process.exitCode = await testProcess.exited;
}

runIntegrationTests().catch((error: unknown) => {
  console.error('Could not run integration tests:', error);
  process.exitCode = 1;
});
