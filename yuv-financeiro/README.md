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
| Boleto / Pix | **Asaas** (`BILLING_PROVIDER=asaas`) ou simulado |
| NFS-e | **Asaas** — emitida na cobrança ("Boleto + NF") ou quando o pagamento quita ("Só boleto") |
| Baixa de pagamento | Automática pelo webhook da Asaas; extrato OFX/CSV para o que entrar fora da Asaas |
| Sincronização de dispositivos com a plataforma | Não existe; quantidades entram pela planilha ou pela tela do cliente |
| Relatório em PDF | Não implementado; relatórios saem em CSV (abre no Excel) |

## Asaas

A integração foi escrita conferindo campos e rotas no pacote oficial da Asaas no npm
(`@asaasbr/n8n-nodes-asaas`) e em SDKs da comunidade, e testada contra uma API simulada
(`test/asaas.test.js`). **Ainda não rodou contra a Asaas de verdade** — faça o roteiro de sandbox abaixo antes
de virar para produção.

O que o sistema faz:
- No envio da cobrança: procura o cliente na Asaas pelo CNPJ (ou cria) e cria a cobrança com vencimento,
  valor e `externalReference` = id da cobrança. Se o contrato tem "Multa + juros", manda `fine`/`interest`;
  se tem "Desconto pontualidade", manda `discount` até o vencimento.
- "Boleto + NF": agenda e autoriza a NFS-e (`POST /invoices` + `/authorize`) junto com a cobrança.
- "Só boleto": a NFS-e sai quando o pagamento quita a cobrança.
- Webhook `PAYMENT_RECEIVED`/`PAYMENT_CONFIRMED` dá baixa (sem duplicar), `INVOICE_AUTHORIZED` guarda o link do PDF,
  `INVOICE_ERROR` e estornos aparecem no histórico do cliente.
- Falhou boleto ou NF? A cobrança fica registrada, aparece "Gerar boleto/NF" na Conciliação e o e-mail
  só é enviado quando o boleto existir.

### Fase 1: só boleto (NF fora do sistema)

Com `NF_AUTOMATICA=0` (padrão) o sistema gera só o boleto na Asaas e **não chama nada de nota fiscal** —
não precisa configurar serviço municipal nem alíquotas. A coluna "Nota fiscal" da Conciliação passa a
controlar o que emitir à mão:
- cliente "Boleto + NF": já nasce como **Emitir NF manualmente**;
- cliente "Só boleto": fica **Aguardando pgto** e vira **Emitir NF manualmente** quando o pagamento quita;
- depois de emitir a nota no seu emissor atual, clique **NF emitida** (pode informar o número) — fica no histórico.

O relatório "NFs pendentes pós-pagamento" lista as que faltam. Para ligar a NF depois, preencha `ASAAS_NF_*`,
mude para `NF_AUTOMATICA=1` e reinicie; as cobranças antigas marcadas como manuais continuam manuais.

### Roteiro para ligar

1. Crie conta no sandbox (https://sandbox.asaas.com), gere a chave de API e preencha `ASAAS_*` no `.env`
   com `ASAAS_ENV=sandbox` e `BILLING_PROVIDER=asaas`.
2. (Só quando for ligar a NF) Configure as notas fiscais na Asaas e, com a contabilidade, preencha
   `ASAAS_NF_SERVICO_ID` (ou código + nome), as alíquotas `ASAAS_NF_*` e `NF_AUTOMATICA=1`.
3. Na Asaas, em Integrações > Webhooks, cadastre `https://SEU-DOMINIO/api/webhooks/asaas`, com o token
   de `ASAAS_WEBHOOK_TOKEN` e os eventos de cobrança (e de nota fiscal, quando ligar a NF).
4. Reinicie (`pm2 restart yuv-financeiro --update-env`), cadastre 1 cliente de teste com CNPJ válido,
   envie a cobrança, pague no sandbox e confira: link do boleto na Conciliação, e-mail com o link e baixa automática.
5. Só então troque para `ASAAS_ENV=production` com a chave de produção.

Sem `ASAAS_API_KEY` (ou, com `NF_AUTOMATICA=1`, sem serviço municipal) o sistema nem sobe — de propósito, para não emitir
cobrança sem NF.

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

### Produção (VPS com nginx + pm2 + certbot)

```bash
git clone -b claude/blissful-mccarthy-eu7bs3 https://github.com/pettersonpedros/instaladorwhatsapsaas-main-master.git /opt/yuv
cd /opt/yuv/yuv-financeiro
sudo bash deploy/instalar.sh financeiro.seudominio.com.br seu@email.com
```

O script instala um **Node 22 separado** em `/opt/node-v22.22.0` (o instalador do WhatsApp SaaS usa Node 16,
que não roda este sistema, e trocar o Node global poderia derrubar o WhatsApp SaaS), cria o `.env`,
sobe no pm2 do root, configura nginx + HTTPS e agenda backup diário em `data/backups`.
O DNS do domínio precisa apontar para a VPS antes. Depois edite o `.env` (SMTP e Asaas) e rode
`pm2 restart yuv-financeiro --update-env`.

Atualizar: `git pull && PATH=/opt/node-v22.22.0/bin:$PATH npm ci --omit=dev && pm2 restart yuv-financeiro`.
- Ou Docker: `docker build -t yuv-financeiro . && docker run -d -p 127.0.0.1:3080:3080 -v yuv-data:/data --env-file .env yuv-financeiro`.
- **Backup**: `scripts/backup.js` (o instalador agenda diário). Copie `data/backups` para **fora da VPS**
  (S3, Google Drive, outro servidor) — backup na mesma máquina não protege contra perder a máquina.
- Rode **uma** instância só: o agendador vive no processo.

## Estrutura

```
shared/domain.js    regras de negócio (cálculo, período, teste, relatórios) — servidor e navegador
server/db.js        esquema SQLite e acesso a dados
server/services.js  ações que mexem em dinheiro (cobrança, pagamento, extrato, importação)
server/app.js       rotas da API
server/scheduler.js relatórios agendados e avisos de fim de teste
server/providers.js integração de boleto/NF (Asaas ou simulada)
deploy/             instalador da VPS e configuração do pm2
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
