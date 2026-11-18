import { SqsService } from '../src/infrastructure/messaging/sqs.client';

async function run() {
  console.log('Criando filas SQS FIFO no LocalStack...');
  const sqs = new SqsService();
  await sqs.ensureQueues();
  console.log('Filas criadas com sucesso!');
}

run().catch((err) => {
  console.error('Erro ao inicializar filas SQS:', err);
  process.exit(1);
});
