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
* LocalStack na porta 4566, com as filas FIFO `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` criadas automaticamente.

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

Os testes unitários usam dublês em memória. Os testes que precisam de PostgreSQL e SQS reais ficam separados no perfil `integration`.

### Sequência recomendada no Windows / PowerShell

1. Abra o Docker Desktop e espere o engine ficar pronto.
2. No terminal, na pasta do projeto, instale dependências e rode as verificações locais:

```powershell
bun install
bun run typecheck
bun test
```

3. Suba os serviços isolados de teste e confirme o estado:

```powershell
docker compose --profile integration up -d postgres-test localstack-test
docker compose --profile integration ps
```

Espere `postgres-test` e `localstack-test` ficarem `healthy`. Se algum deles não ficar saudável:

```powershell
docker compose --profile integration logs --tail 80 postgres-test localstack-test
```

4. Execute a integração com migrations, SQS/LocalStack e três processos Bun concorrentes:

```powershell
bun run test:integration
```

5. Depois da validação, os containers podem continuar ligados para outra rodada ou ser parados sem apagar os volumes:

```powershell
docker compose --profile integration down
```

Os testes de integração usam PostgreSQL separado na porta `5433`, banco `wagering_test_db`, e LocalStack separado na porta `4567`. O script aplica as migrations de teste e configura URLs SQS próprias. Os testes unitários não dependem desses containers; o teste de concorrência unitário simula os locks e não substitui a integração real.

### Comandos individuais

```powershell
bun run test:unit
bun run test:concurrency
bun run test:load
```

Só integre em `main` depois que `bun run typecheck`, `bun test` e `bun run test:integration` terminarem sem falhas.

---

## Exemplos de Uso da API

Abaixo você encontra o passo a passo completo para testar as operações financeiras.

> **Importante**: No **Passo 1 (Criar Carteira)**, a API retornará o `id` da carteira criada. Copie esse ID e utilize-o nos comandos seguintes substituindo o valor de `walletId` ou no final da URL.

---

### Passo 1: Criar Carteira

**PowerShell (Windows):**
```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets" -ContentType "application/json" -Body '{"playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "initialBalance": {"amount": "100.00", "currency": "BRL"}}' | ConvertTo-Json
```

**Bash / Linux / macOS (cURL):**
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
  "id": "2b99c51e-e4a2-40ac-b568-14fcd1e4a516",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

---

### Passo 2: Consultar Carteira
Substitua o ID no final da URL pelo ID da carteira que você criou no Passo 1.

**PowerShell:**
```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/wallets/2b99c51e-e4a2-40ac-b568-14fcd1e4a516" | ConvertTo-Json
```

**Bash / cURL:**
```bash
curl -X GET http://localhost:3000/wallets/2b99c51e-e4a2-40ac-b568-14fcd1e4a516
```

---

### Passo 3: Fazer uma Aposta (BET)
Envie uma aposta de R$ 25,00 informando o `walletId` da carteira criada no Passo 1:

**PowerShell:**
```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wagering/transactions" -ContentType "application/json" -Headers @{"Idempotency-Key"="prov-1:bet-101"} -Body '{"providerId":"prov-1","externalTransactionId":"bet-101","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"2b99c51e-e4a2-40ac-b568-14fcd1e4a516","roundId":"round-1","gameId":"fortune-tiger","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}' | ConvertTo-Json
```

**Bash / cURL:**
```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: prov-1:bet-101" \
  -d '{
    "providerId": "prov-1",
    "externalTransactionId": "bet-101",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "2b99c51e-e4a2-40ac-b568-14fcd1e4a516",
    "roundId": "round-1",
    "gameId": "fortune-tiger",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Resposta esperada (HTTP 200):
```json
{
  "transactionId": "67b839e7-463b-49e6-b66c-7b3029b2e6d1",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

---

### Passo 4: Teste de Idempotência
Reenvie exatamente o mesmo comando do Passo 3 (mesma `Idempotency-Key` e mesmo payload).

A API responderá com `"idempotentReplay": true`, confirmando o processamento sem debitar a carteira uma segunda vez (saldo permanece em 75.00 BRL):

```json
{
  "transactionId": "67b839e7-463b-49e6-b66c-7b3029b2e6d1",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": true
}
```

---

### Passo 5: Consultar Extrato (Ledger)
Lista os lançamentos contábeis históricos da carteira (crédito inicial de abertura e o débito da aposta):

**PowerShell:**
```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/wallets/2b99c51e-e4a2-40ac-b568-14fcd1e4a516/ledger" | ConvertTo-Json
```

**Bash / cURL:**
```bash
curl -X GET "http://localhost:3000/wallets/2b99c51e-e4a2-40ac-b568-14fcd1e4a516/ledger?limit=20"
```

---

### Passo 6: Reconciliação Contábil da Carteira
Valida se a soma matemática de todo o histórico do ledger coincide exatamente com o saldo armazenado na carteira:

**PowerShell:**
```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets/2b99c51e-e4a2-40ac-b568-14fcd1e4a516/reconciliation" | ConvertTo-Json
```

**Bash / cURL:**
```bash
curl -X POST http://localhost:3000/wallets/2b99c51e-e4a2-40ac-b568-14fcd1e4a516/reconciliation
```

Resposta esperada:
```json
{
  "walletId": "2b99c51e-e4a2-40ac-b568-14fcd1e4a516",
  "storedBalance":     { "amount": "75.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "75.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",  "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

---

### Passo 7: Health Checks e Métricas

**PowerShell:**
```powershell
# Liveness
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health/live" | ConvertTo-Json

# Readiness (valida PostgreSQL e as filas SQS de entrada, eventos e DLQ)
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health/ready" | ConvertTo-Json

# Métricas internas
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health/metrics" | ConvertTo-Json
```

**Bash / cURL:**
```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
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
