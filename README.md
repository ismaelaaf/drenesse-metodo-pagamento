# Landing Drenesse com pagamento Asaas

Cópia independente de `ismaelaaf/drenesse-metodo`. Mantém o formulário React + Vite e a captura de leads na Lever. O agendamento na Belle acontece somente depois da confirmação financeira do Asaas.

## Fluxo

1. O visitante informa nome, WhatsApp, unidade, objetivo, rotina e horário, como na LP original.
2. `/api/create-checkout` verifica elegibilidade e disponibilidade, salva o pedido no PostgreSQL e cria um Checkout Asaas avulso de R$ 89,90, com Pix e cartão à vista. O checkout expira em 10 minutos.
3. O Asaas coleta os dados adicionais necessários ao pagamento em sua página hospedada. Os campos da LP permanecem iguais aos da versão original.
4. O webhook autenticado `CHECKOUT_PAID` identifica o pedido e consulta a cobrança do checkout no Asaas. Só aceita `CONFIRMED` ou `RECEIVED`, com o valor integral da campanha.
5. Depois da confirmação, confere novamente o horário e a elegibilidade, cria o cadastro Belle e envia `/agenda/gravar` uma única vez por pedido.
6. A página de retorno consulta o pedido salvo e mostra o resultado. O retorno do navegador jamais confirma pagamento nem cria agendamento. O webhook funciona mesmo com a página fechada.

O endpoint antigo `/api/submit-booking` retorna HTTP 402 e não grava mais na Belle nesta LP.

## Configurar antes de ativar pagamentos

1. Instale com `pnpm install` e configure `.env.local` a partir de `.env.example`.
2. Use um banco PostgreSQL e execute `db/001-payment-orders.sql`. As tabelas são privadas, com RLS habilitado e acesso apenas pelo servidor. Configure `DATABASE_URL` com uma conexão protegida conforme o provedor. Não exponha o banco ou as chaves em variáveis `VITE_*`.
3. Configure as variáveis da Belle e da Lever já utilizadas pela LP original.
4. Configure `ASAAS_API_KEY` inicialmente com uma chave do Sandbox; mantenha `ASAAS_ENVIRONMENT=sandbox`.
5. Gere um segredo separado de ao menos 32 caracteres para `ASAAS_WEBHOOK_TOKEN` e configure o mesmo valor como `authToken` no Asaas. A chave de API não deve ser usada como token do webhook.
6. Configure `APP_URL` com a URL pública HTTPS da **nova** LP.
7. No Asaas, cadastre um webhook para `APP_URL/api/asaas-webhook`, com `CHECKOUT_PAID`, `CHECKOUT_CANCELED` e `CHECKOUT_EXPIRED`. O header esperado é `asaas-access-token`.
8. Homologue a compra no Sandbox com uma integração Belle de teste, confira o agendamento e teste cancelamento, horário ocupado e reenvio do webhook. Só depois configure a chave de produção e `ASAAS_ENVIRONMENT=production`.

Sem a configuração completa, criar checkout retorna HTTP 503. Esta alteração não provisiona banco, não cadastra webhook e não ativa cobranças reais.

## Garantias e tratamento de falhas

- Pedidos e eventos são persistidos; nenhuma garantia depende de memória de uma função serverless ou do navegador do comprador.
- Cada envio final possui um identificador estável e um token aleatório. Repetir a mesma requisição reutiliza o checkout.
- A cobrança e o valor são definidos no servidor; dados enviados pelo navegador não podem marcar um pedido como pago.
- Uma atualização condicional no banco permite que apenas uma execução processe o pedido pago. Eventos repetidos, concorrentes ou de expiração posteriores ao pagamento não geram outro agendamento.
- Falha ou timeout após iniciar uma gravação Belle exige conferência humana: não é seguro repetir automaticamente uma operação que pode ter sido aceita.
- Se o horário ficar indisponível ou ocorrer falha de integração, o pagamento permanece registrado e o pedido fica `needs_attention`. A LP orienta contato com o atendimento e informa que não é necessário pagar novamente. Não há estorno automático.
- Se a função for interrompida durante uma gravação, uma nova entrega do webhook após três minutos marca a ocorrência para conferência, sem repetir a gravação.
- O webhook responde 200 depois de concluir o processamento ou registrar a necessidade de atendimento. Falhas de banco/confirmação respondem 503 para nova entrega pelo Asaas. Monitore a fila e os logs no painel do Asaas.
- Se a criação de checkout falhar com resultado incerto, o pedido fica `setup_unknown`. Conferir no Asaas pela `externalReference` antes de gerar uma cobrança substituta.
- A escolha do horário não reserva uma vaga na Belle antes do pagamento. A disponibilidade é verificada novamente e a resposta da Belle determina a confirmação final.

## Conferência operacional

Use no banco, com acesso de servidor:

```sql
SELECT id, status, checkout_id, payment_id, paid_at, lead_code,
       booking_code, attention_reason, updated_at
FROM drenesse_orders
WHERE status IN ('needs_attention', 'setup_unknown', 'processing')
ORDER BY updated_at;
```

Confira a cobrança no Asaas e o agendamento na Belle antes de qualquer gravação manual ou estorno. O código do pedido também está na observação enviada à Belle.

## Rodar e verificar

- `pnpm dev`: LP e APIs locais do Vite.
- `pnpm test`: testes existentes e novos testes de pagamento, com PostgreSQL em memória e Asaas/Belle simulados. Não movimentam dinheiro nem cadastram pessoas reais.
- `pnpm build`: gera `dist`.

Na Vercel, importe **este novo repositório**, use `pnpm build`, publique `dist` e configure as variáveis protegidas no projeto novo. As funções de checkout e webhook usam duração máxima de 120 segundos.

## Referências

- [Checkout Asaas](https://docs.asaas.com/docs/checkout-asaas)
- [Eventos de Checkout](https://docs.asaas.com/docs/eventos-para-checkout)
- [Webhooks e autenticação](https://docs.asaas.com/docs/sobre-os-webhooks)
- [Consultar cobranças de um checkout](https://docs.asaas.com/reference/listar-cobrancas)
