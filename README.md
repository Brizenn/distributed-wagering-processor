# Distributed Wagering Processor

Serviço financeiro de processamento de transações de apostas para múltiplos provedores de jogos, desenvolvido em NestJS com Bun, PostgreSQL e AWS SQS.

O projeto foi desenhado com foco em consistência financeira estrita, concorrência segura entre múltiplas instâncias, idempotência persistente e arquitetura orientada a eventos via Transactional Outbox e Inbox.

---

## Stack do Projeto

* Runtime e Test Runner: Bun 1.x
* Linguagem: TypeScript (strict mode)
* Framework: NestJS 11
* Banco de Dados: PostgreSQL 16
* ORM: MikroORM v6 (Driver PostgreSQL, migrations versionadas)
* Mensageria: AWS SQS FIFO (LocalStack)
* Ambiente Local: Docker Compose

---

## Pré-requisitos

* Bun 1.x instalado (https://bun.sh)
* Docker e Docker Compose

---

## Como Rodar o Projeto

### 1. Instalar as dependências
```bash
bun install
```

### 2. Subir os containers (PostgreSQL e LocalStack)
```bash
docker-compose up -d
```
O comando acima inicializa:
* PostgreSQL 16 na porta 5432
* LocalStack na porta 4566, com as filas FIFO `wager-transactions.fifo` e `wager-transactions-dlq.fifo` criadas automaticamente pelo script de inicialização.

### 3. Executar as migrations do banco
```bash
bun run migration:up
```

### 4. Iniciar a aplicação
```bash
bun run start:dev
```
A API ficará disponível em `http://localhost:3000`.

---

## Testes

A suíte cobre validações de domínio, idempotência, isolamento transacional e cenários de concorrência real:

```bash
# Executar todos os testes
bun test

# Executar apenas testes unitários
bun run test:unit

# Executar testes de concorrência (cenário da Seção 8 e 50 requisições simultâneas)
bun run test:concurrency

# Executar benchmark de carga
bun run test:load
```

---

## Exemplos de Uso da API

### Criar Carteira
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "100.00", "currency": "BRL" }
  }'
```

Resposta esperada (HTTP 201):
```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

### Submeter Aposta (BET)
```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:bet-101" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "bet-101",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Resposta esperada (HTTP 200):
```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Se o mesmo payload for reenviado com a mesma chave, a API retorna a mesma resposta com `"idempotentReplay": true`, sem duplicar o débito.

### Consultar Extrato (Ledger) com Paginação
```bash
curl -X GET "http://localhost:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger?limit=20"
```

### Reconciliação Contábil da Carteira
Valida a paridade entre o saldo materializado na carteira e a soma de todos os lançamentos históricos do ledger:
```bash
curl -X POST http://localhost:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation
```

Resposta esperada:
```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance":     { "amount": "75.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "75.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",  "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

### Health Checks e Métricas
```bash
# Liveness
curl http://localhost:3000/health/live

# Readiness (valida conectividade com PostgreSQL)
curl http://localhost:3000/health/ready

# Métricas internas de processamento
curl http://localhost:3000/health/metrics
```

---

## Principais Invariantes de Negócio

1. **Dinheiro**: Valores monetários são manipulados através da classe `Money` com `decimal.js`, sem uso de tipos `number` ou `float`. No banco, são armazenados em colunas `numeric(15, 2)`.
2. **Saldo Não Negativo**: Protegido no código de domínio e garantido via constraint `CHECK (balance >= 0)` no PostgreSQL.
3. **Concorrência**: Travamento pessimista de linha (`SELECT ... FOR UPDATE`) na carteira, serializando operações simultâneas na mesma wallet e evitando lost updates.
4. **Idempotência**: Baseada em chave única persistente e hash canônico determinístico (SHA-256) dos campos de negócio.
5. **Transactional Outbox**: Eventos são salvos na mesma transação atômica das apostas. O worker de publicação utiliza `FOR UPDATE SKIP LOCKED`, suportando múltiplas instâncias concorrentes.
6. **Inbox Pattern**: Mensagens consumidas do SQS são deduplicadas por `(consumer_name, message_id)`. O ack é emitido somente após o commit transacional.
7. **Referências Fora de Ordem**: Estornos que chegarem antes da aposta de origem recebem status `PENDING_REFERENCE` e são reprocessados automaticamente quando a referência é encontrada.

Para mais detalhes sobre as decisões e trade-offs técnicos, consulte o documento [ARCHITECTURE.md](ARCHITECTURE.md).
