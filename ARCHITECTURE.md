# Arquitetura e Decisões Técnicas

Este documento reúne as decisões de engenharia, escolhas de design e justificativas adotadas no desenvolvimento do processador financeiro de apostas para o desafio técnico da Jungle Gaming.

---

## 1. Escolha do ORM: MikroORM

O desafio sugeriu o MikroORM como preferencial ou TypeORM como aceito. Optamos pelo **MikroORM v6** pelos seguintes motivos práticos:

1. **Unit of Work e Identity Map**: O MikroORM gerencia o ciclo de vida das entidades de forma transacional, garantindo que a mesma linha do banco não seja representada por instâncias conflitantes na memória dentro do mesmo escopo.
2. **Locking Pessimista Explícito**: O suporte a `LockMode.PESSIMISTIC_WRITE` permite aplicar `SELECT ... FOR UPDATE` diretamente pela API do EntityManager, sem necessidade de queries manuais em string.
3. **Isolamento entre Domínio e Infraestrutura**: Seguindo princípios de DDD, o modelo de domínio (`Wallet`, `Money`, `WagerTransaction`) permaneceu em TypeScript puro, sem acoplamento a decorators do ORM. Criamos entidades separadas de persistência (`WalletEntity`, etc.) e mappers para a conversão de/para o domínio.

---

## 2. Precisão Monetária e Invariantes do Schema

### Representação de Dinheiro
Para valores monetários, o uso de `number` ou `float` foi completamente evitado devido a problemas de precisão em ponto flutuante (IEEE 754).

* **Classe `Money`**: Implementada como Value Object imutável, utilizando internamente `decimal.js` com escala fixa de 2 casas decimais.
* **Validações**: Rejeita entradas com notação científica, valores negativos em contratos de entrada, strings vazias e moedas incompatíveis (lançando `CurrencyMismatchError`).
* **Banco de Dados**: Colunas mapeadas como `numeric(15, 2)` no PostgreSQL.

### Invariantes no Banco de Dados
Para garantir a consistência mesmo sob eventuais falhas da aplicação, as seguintes regras foram fixadas no schema via DDL:

* `chk_wallet_balance_non_negative`: `CHECK (balance >= 0)` na tabela `wallets`, impedindo saldo negativo no nível de armazenamento.
* `uq_wallet_player_currency`: `UNIQUE (player_id, currency)` para garantir no máximo uma carteira por jogador e moeda.
* `chk_ledger_math`: Constraint na tabela `wallet_ledger` que valida a matemática da movimentação:
  ```sql
  CHECK (
    (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
    (direction = 'DEBIT' AND balance_before - amount = balance_after)
  )
  ```
* `wallet_ledger` é append-only: triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE`; há no máximo um lançamento por transação e chaves estrangeiras garantem wallet/moeda/transação coerentes.
* `wager_transactions` também valida valores não negativos, kinds/status permitidos e snapshot de saldo completo; índices parciais impedem repetir REFUND ou ROLLBACK processados para a mesma referência.
* Unicidade de transações: `UNIQUE (provider_id, external_transaction_id)` e `UNIQUE (idempotency_key)`.

---

## 3. Concorrência e Serialização de Carteiras

### Unidade de Concorrência
A granularidade de bloqueio é por **`walletId`**. Operações em carteiras diferentes acontecem em paralelo sem contenção.

### Estratégia de Lock
Optamos por **Pessimistic Write Lock (`SELECT ... FOR UPDATE`)** em vez de Optimistic Locking pelos seguintes motivos:

1. Em carteiras com alto volume de apostas simultâneas ("hot wallets"), o lock otimista gera muitas falhas de versão, exigindo loops de retry que aumentam o consumo de CPU e a latência da API.
2. A trava pessimista coloca as requisições concorrentes daquela carteira em fila no próprio banco.

Antes de consultar os registros de idempotência, cada operação também adquire advisory transaction locks do PostgreSQL para a chave de idempotência e para a identidade `(providerId, externalTransactionId)`, sempre na mesma ordem. Isso fecha a corrida entre requisições simultâneas que ainda não encontraram uma linha existente. Esses locks são por identidade da operação; o lock da wallet continua sendo o que serializa alterações de saldo.

**Exemplo do cenário obrigatório da Seção 8:**
* Carteira com saldo inicial de 100.00 BRL recebe duas apostas de 80.00 BRL ao mesmo tempo.
* A primeira aposta adquire o lock na linha da carteira, debita 80.00 (saldo vai a 20.00), grava o ledger e faz commit.
* A segunda aposta é liberada da fila do banco, lê o saldo atualizado (20.00), constata saldo insuficiente e rejeita imediatamente com `INSUFFICIENT_FUNDS`.
* Resultado: saldo final de 20.00 BRL, um único lançamento de débito no ledger e nenhuma duplicação.

---

## 4. Idempotência e Hash Canônico

Para garantir que reenvios de mensagens ou requisições repetidas não causem movimentações duplicadas:

1. **Header `Idempotency-Key`**: Obrigatório na API HTTP e limitado a 255 caracteres. Mensagens SQS também precisam trazer uma chave. O use case mantém um fallback `{providerId}:{externalTransactionId}` apenas para chamadas internas sem chave explícita.
2. **Hash Canônico (SHA-256)**:
   * Chaves do JSON são ordenadas alfabeticamente de forma recursiva antes do hashing, evitando que diferenças de formatação ou ordem de propriedades gerem hashes distintos para a mesma operação.
   * Apenas dados de negócio entram no cálculo: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. O valor é normalizado por `Money` como string decimal antes do SHA-256.
3. **Respostas**:
   * **Payload idêntico**: Retorna a resposta original com `idempotentReplay: true`, inclusive o saldo observado no processamento original, sem debitar a carteira novamente.
   * **Mesma chave com payload alterado**: Retorna `409 Conflict`, pois se trata de uma inconsistência e não de um replay legítimo.

---

## 5. Mensageria: Transactional Outbox e Inbox

```
Requisicao HTTP / SQS Consumer
             |
             v
+-------------------------------+
|     Transacao SQL (ACID)      |
|  - Lock na Wallet (FOR UPDATE)|
|  - Atualiza Saldo             |
|  - Grava Ledger               |
|  - Grava WagerTransaction     |
|  - Grava Inbox (se veio SQS)  |
|  - Grava Outbox (Evento)      |
+-------------------------------+
             | (Commit)
             v
OutboxPublisher Worker (FOR UPDATE SKIP LOCKED)
             |
             v
       Fila wager-events.fifo
```

### Transactional Outbox
Para resolver o problema de escrita dupla (*dual-write*):
* A gravação do evento na tabela `outbox` ocorre dentro da mesma transação SQL da aposta.
* O envio para a fila dedicada de eventos `wager-events.fifo` é feito assincronamente pelo `OutboxPublisher`; a fila de entrada não consome nem descarta eventos de saída.
* O publisher faz a leitura usando **`FOR UPDATE SKIP LOCKED`**, o que permite subir múltiplas instâncias sem que dois publishers reivindiquem a mesma linha ao mesmo tempo. A entrega é at-least-once: se o SQS aceitar o evento e o processo morrer antes do commit de `published_at`, ele pode ser reenviado; consumidores downstream devem deduplicar pelo `eventId`.
* Em falhas de rede com a AWS/LocalStack, o worker calcula e persiste o próximo agendamento com **Backoff Exponencial** (1s, 2s, 4s, 8s até 60s).

### Inbox Pattern
* Na ingestão de mensagens da fila `wager-transactions.fifo`, o `SqsConsumer` valida a chave composta `(consumer_name, message_id)` na tabela `inbox`.
* Mensagens repetidas enviadas pelo SQS são descartadas antes de executar a lógica de débito.
* O Ack (`deleteMessage`) no SQS só é executado **após o commit da transação SQL**.
* Inbox, wager, saldo, ledger e outbox usam o mesmo `EntityManager` transacional; falha no commit reverte todos juntos.

---

## 6. Tratamento de Referências Fora de Ordem

Quando um estorno (`REFUND` ou `ROLLBACK`) chega antes da aposta de origem:

1. A transação é salva com status `PENDING_REFERENCE` (HTTP 202 Accepted).
2. O `PendingReferenceWorker` consulta transações vencidas a cada intervalo configurável; tentativas e próxima execução ficam persistidas, com backoff de 1s até 60s.
3. Assim que a aposta de origem é persistida no banco, o worker reprocessa o estorno e credita a carteira.
4. Caso a referência não chegue dentro do tempo limite (**TTL de 5 minutos**), a transação é marcada como `REJECTED` com o código `REFERENCE_NOT_FOUND` e o evento correspondente é emitido na outbox.

Os endpoints `/health/live` e `/health/ready` são públicos. A readiness verifica PostgreSQL e as filas SQS de entrada, eventos e DLQ e retorna indisponibilidade se qualquer dependência estiver fora do ar.

---

## 7. Mapeamento de Status e Códigos de Falha

| Código de Falha | HTTP Status | Causa |
|---|---|---|
| `INSUFFICIENT_FUNDS` | 422 | Saldo insuficiente para a aposta. |
| `ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE` | 422 | Reversão de ganho deixaria a carteira negativa. |
| `REFERENCE_NOT_FOUND` | 422 | Transação de referência não existe ou expirou o TTL. |
| `REFERENCE_ALREADY_REVERSED` | 422 | A transação referenciada já foi revertida. |
| `INVALID_REFERENCE_KIND` | 422 | Kind da referência incompatível com a operação. |
| `CURRENCY_MISMATCH` | 422 | Moeda da aposta difere da moeda da carteira. |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | 409 | Mesma Idempotency-Key reutilizada com payload diferente. |
| `WALLET_NOT_FOUND` | 404 | Carteira inexistente. |
| `INVALID_PAYLOAD` | 400 | Campos obrigatórios ausentes ou em formato inválido. |

---

## 8. Decisão sobre Autenticação (Seção 2)

Conforme a Seção 2 do desafio:
> *"Se você optar por não implementar, isso é aceito: documente a decisão no ARCHITECTURE.md, descreva o desenho que adotaria e deixe o ponto de extensão explícito no código..."*

Optamos por não subir um Identity Provider completo (Keycloak/Zitadel) em container local para priorizar a correção financeira, concorrência, idempotência e os testes.

* **Ponto de extensão**: Implementamos a classe `ProviderAuthGuard` em `src/presentation/auth/auth.guard.ts`.
* **Endpoints abertos**: Rotas de `/health` e métricas utilizam o decorator `@Public()`.
* **Arquitetura para produção**: A integração ideal utilizaria o Zitadel com fluxo OAuth2 *Client Credentials* (M2M). O `ProviderAuthGuard` verificaria a assinatura do JWT contra as chaves públicas (JWKS) do IdP, extraindo a identidade do provedor autenticado para as validações de domínio.
