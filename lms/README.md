# LMS de Treinamentos (vídeos do YouTube)

Plataforma de treinamento para clientes com aulas em vídeo do **YouTube** (sem custo de armazenamento),
provas, liberação de módulos por regra, relatórios de quem assistiu o quê e **gatilhos automáticos**
(WhatsApp via API do Whaticket, e-mail, webhook, matrícula em outro curso, notificação no painel).

Stack: Node.js 18+ · Express · PostgreSQL · EJS (renderizado no servidor, sem build de frontend).

## Perfis de acesso

| Perfil | O que faz |
|---|---|
| **Admin** | Tudo, inclusive equipe e Configurações (WhatsApp, SMTP, marca). |
| **Funcionário** | Vê painel e relatórios. Permissões opcionais por usuário: editar conteúdo, gerenciar alunos/empresas, gerenciar gatilhos. |
| **Aluno** | Vê só os cursos em que está matriculado. |

Alunos podem ser agrupados por **Empresa** (cliente) para matricular em lote e filtrar relatórios.

## Funcionalidades

- **Cursos → Módulos → Aulas** com link do YouTube (título puxado automaticamente) ou aula só de texto.
- **Rastreamento real do vídeo**: registra os trechos efetivamente assistidos (não só "deu play").
  A aula conclui ao atingir o % mínimo (padrão 90%, configurável por curso/aula). Retoma de onde parou.
  - Opção "bloquear avançar o vídeo" por curso.
  - Anti-fraude no servidor: o progresso não pode crescer mais rápido que o tempo real (com folga para 2x).
- **Regras de liberação de módulo** (combináveis): concluir o módulo anterior, **ser aprovado em uma prova**,
  liberar X dias após a matrícula (conteúdo gotejado). Aulas em sequência opcional.
- **Provas**: escolha única, múltipla escolha, V/F; nota mínima, nº de tentativas, tempo limite com
  cronômetro e envio automático, embaralhamento, gabarito com explicação, obrigatória ou opcional.
  Provas por módulo ou avaliação final.
- **Materiais complementares** por curso, módulo ou aula: link (Drive/Dropbox — recomendado) ou upload.
- **Certificado** automático com código de verificação pública (`/certificado/CODIGO`), imprimível em PDF.
- **Relatórios**: por curso (status, %, módulo atual, dias para concluir, notas; filtro por empresa;
  exportação CSV para Excel), funil por aula (onde os alunos param), "quem assistiu" por aula e
  ficha do aluno com linha do tempo completa.
- **Gatilhos**: Quando *evento* + *condição* → esperar X → *ação*.
  - Eventos: matriculado, concluiu aula, concluiu módulo, **concluiu curso (em até / depois de X dias)**,
    aprovado/reprovado em prova (faixa de nota, esgotou tentativas), **não concluiu em X dias**,
    **não iniciou em X dias**, **X dias sem acessar**.
  - Ações: WhatsApp, e-mail, webhook (JSON assinado com HMAC), matricular em outro curso, notificar admin.
  - Variáveis: `{{nome}} {{primeiro_nome}} {{curso}} {{modulo}} {{prova}} {{nota}} {{dias}} {{progresso}} {{link_curso}} {{link_certificado}}`...
  - Cada gatilho dispara uma vez por aluno/curso; fila com 3 tentativas, histórico e botão reprocessar.
  - Gatilhos por tempo são cancelados se o aluno concluir antes do envio.
- Importação de alunos por CSV (`nome;email;telefone;empresa`) e envio de acesso por WhatsApp/e-mail.

## Instalação (VPS Ubuntu, mesma máquina do Whaticket)

```bash
# 1) Banco separado no Postgres já instalado
sudo -u postgres psql -c "CREATE USER lms PASSWORD 'TROQUE_AQUI';"
sudo -u postgres createdb -O lms lms

# 2) App
cd /home/deploy && git clone <este-repo> && cd <repo>/lms
npm ci --omit=dev
cp .env.example .env    # edite DATABASE_URL, SESSION_SECRET (openssl rand -hex 32), PUBLIC_URL
npm run migrate
npm run create-admin -- "Seu Nome" voce@empresa.com SenhaForte123

# 3) Rodar com PM2 (já usado pelo Whaticket)
pm2 start src/server.js --name lms && pm2 save
```

Nginx (HTTPS com certbot, igual aos outros domínios):

```nginx
server {
  server_name treinamento.suaempresa.com.br;
  client_max_body_size 30M;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Depois: `sudo certbot --nginx -d treinamento.suaempresa.com.br` e `COOKIE_SECURE=true` no `.env`.

**Rode só UMA instância** do processo (o worker de gatilhos roda dentro dele). Se precisar escalar,
use `DISABLE_WORKER=true` nas instâncias extras.

## Integração com o WhatsApp (Whaticket)

Em **Configurações**: URL `https://SEU-BACKEND/api/messages/send` + token da conexão (Whaticket →
Conexões → editar → Token). O LMS envia `POST {"number":"55119...","body":"texto"}` com
`Authorization: Bearer TOKEN`. Use "Testar WhatsApp" para validar. Se sua versão tiver outro endpoint,
use a ação **webhook** + n8n.

## Testes

```bash
createdb lms_test
TEST_DATABASE_URL=postgres://lms:SENHA@localhost:5432/lms_test npm test
```

O teste de ponta a ponta monta um curso pelo admin, simula o aluno assistindo, reprova e aprova na prova,
verifica a liberação do módulo, a conclusão, o certificado, os gatilhos e os relatórios.

## Limitações que você precisa saber

- **Vídeo não listado não é vídeo protegido.** Quem tiver o link assiste fora da plataforma. Para conteúdo
  realmente sigiloso, use Vimeo/Panda Video com restrição de domínio. Vídeos *privados* não tocam embutidos.
- O rastreamento roda no navegador; o anti-fraude do servidor impede atalhos óbvios, mas alguém com
  conhecimento técnico consegue simular progresso. Para treinamento de clientes é suficiente; para
  certificação com valor legal, use a prova como critério principal.
- Recuperação de senha é feita pelo admin ("Redefinir senha / enviar acesso"), não há "esqueci a senha" self-service.
