# YUV Financeiro

Sistema financeiro construído a partir do protótipo `yuv-financeiro3.html`: clientes e contratos,
tabelas de preço versionadas, importação de planilha, cobrança mensal, conciliação bancária,
contas a pagar, relatórios agendados e painel de insights.

## O que é real e o que ainda é simulado

| Parte | Situação |
|---|---|
| Login, sessões, usuários | Real (senha com scrypt, cookie HttpOnly/SameSite, limite de tentativas) |
| Banco de dados | Real — SQLite em `DATA_DIR` (arquivo `yuv.db` + pasta `anexos/`) |
| Cálculo da cobrança | Real e feito no servidor (`shared/domain.js`, o mesmo código que a tela usa para a prévia) |
| Cobrança não duplica | Real — índice único (cliente, competência) |
| Histórico/auditoria do cliente | Real — o servidor descreve cada alteração, com usuário e motivo |
| Conciliação | Real via importação de extrato **OFX ou CSV** (baixa automática quando o valor bate) e webhook de pagamento |
| E-mails (cobrança, lembrete, aviso de teste, relatórios) | Real com `SMTP_URL`; sem ele, ficam registrados como "simulado" (`GET /api/outbox`) |
| Agendador (relatórios e avisos de fim de teste) | Real, roda dentro do processo a cada minuto, sem repetir envio |
| **Emissão de boleto** | **Simulada** — `server/providers.js` |
| **Emissão de NF** | **Simulada** — `server/providers.js` |
| Sincronização de dispositivos com a plataforma | Não existe; quantidades entram pela planilha ou pela tela do cliente |
| Relatório em PDF | Não implementado; relatórios saem em CSV (abre no Excel) |

Para produção falta escolher o provedor de boleto + NFS-e (ex.: Asaas, Iugu, Banco Inter + emissor de NFS-e
da prefeitura) e implementar um driver com `createCharge` e `issueNF` em `server/providers.js`.
Multa, juros e desconto de pontualidade marcados no contrato devem ser repassados a esse provedor.

## Rodar

Requer Node 20+.

```bash
cd yuv-financeiro
npm install
cp .env.example .env   # edite
ADMIN_EMAIL=voce@yuv.com.br ADMIN_PASSWORD='uma-senha-forte' npm start
# abre em http://127.0.0.1:3080
```

Dados de demonstração (os mesmos do protótipo), só com banco vazio: `npm run seed:demo`.
Novo usuário: `npm run user:add -- email@yuv.com.br "Nome" senha-com-8+ financeiro`.
Testes: `npm test`.

O `.env` não é carregado sozinho: exporte as variáveis no serviço (systemd/pm2) ou use
`node --env-file=.env server/index.js`.

### Produção

- Rode atrás de nginx com HTTPS e `COOKIE_SECURE=1`. Exemplo com pm2:
  `pm2 start server/index.js --name yuv-financeiro --node-args="--env-file=.env"`.
- Ou Docker: `docker build -t yuv-financeiro . && docker run -d -p 127.0.0.1:3080:3080 -v yuv-data:/data --env-file .env yuv-financeiro`.
- **Backup diário de `DATA_DIR`** (é todo o financeiro). Com o processo rodando use
  `sqlite3 data/yuv.db ".backup data/backup.db"` em vez de copiar o arquivo.
- Rode **uma** instância só: o agendador vive no processo.

## Estrutura

```
shared/domain.js    regras de negócio (cálculo, período, teste, relatórios) — servidor e navegador
server/db.js        esquema SQLite e acesso a dados
server/services.js  ações que mexem em dinheiro (cobrança, pagamento, extrato, importação)
server/app.js       rotas da API
server/scheduler.js relatórios agendados e avisos de fim de teste
server/providers.js integração de boleto/NF (simulada)
server/mailer.js    envio de e-mail
public/             interface (mesmo layout do protótipo)
```

### Extrato CSV aceito

Separador `;` ou `,`, com cabeçalho. Obrigatórias: `data` (dd/mm/aaaa ou aaaa-mm-dd) e `valor`.
Opcionais: `pagador`, `documento` (CNPJ ajuda a identificar o cliente), `id`. Só créditos são lidos.
Reimportar o mesmo extrato não duplica lançamentos.

### Webhook de pagamento

`POST /api/webhooks/payment` com header `x-webhook-secret: $WEBHOOK_SECRET` e corpo
`{"boletoRef": "...", "valor": 123.45, "data": "2026-10-20", "paymentId": "..."}` (ou `invoiceId`).
`paymentId` repetido é ignorado.
