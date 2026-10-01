#!/usr/bin/env bash
# Instala o YUV Financeiro numa VPS Ubuntu/Debian que já tem nginx, pm2 e certbot
# (como a do instalador do WhatsApp SaaS). Não altera o Node nem os apps existentes.
#
# Uso (como root):  bash deploy/instalar.sh financeiro.seudominio.com.br seu@email.com
set -euo pipefail

DOMINIO="${1:-}"; EMAIL="${2:-}"
if [ -z "$DOMINIO" ] || [ -z "$EMAIL" ]; then echo "Uso: bash deploy/instalar.sh <dominio> <email-certbot>"; exit 1; fi
if [ "$(id -u)" != 0 ]; then echo "Rode como root (sudo)."; exit 1; fi
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VER=22.22.0
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Arquitetura não suportada"; exit 1 ;; esac
NODE_DIR=/opt/node-v$NODE_VER
PORTA=3080

echo "==> Node $NODE_VER em $NODE_DIR (separado do Node do sistema)"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-$ARCH.tar.xz" -o /tmp/node.tar.xz
  mkdir -p "$NODE_DIR" && tar -xJf /tmp/node.tar.xz -C "$NODE_DIR" --strip-components=1 && rm /tmp/node.tar.xz
fi
export PATH="$NODE_DIR/bin:$PATH"
command -v pm2 >/dev/null || npm install -g pm2

echo "==> Dependências"
apt-get install -y build-essential python3 >/dev/null 2>&1 || true
cd "$APP_DIR" && npm ci --omit=dev

if ss -ltn | grep -q ":$PORTA "; then
  pm2 describe yuv-financeiro >/dev/null 2>&1 || { echo "A porta $PORTA já está em uso por outro serviço. Mude PORT no .env e no nginx."; exit 1; }
fi

if [ ! -f .env ]; then
  echo "==> Criando .env"
  read -rp "E-mail do primeiro administrador: " ADM_EMAIL
  while true; do
    read -rsp "Senha do administrador (8+ caracteres, sem aspas): " ADM_PASS; echo
    [ ${#ADM_PASS} -ge 8 ] && [[ "$ADM_PASS" != *'"'* ]] && break
    echo "   Senha inválida, tente de novo."
  done
  grep -vE '^(PORT|APP_URL|DATA_DIR|ADMIN_EMAIL|ADMIN_PASSWORD|WEBHOOK_SECRET|ASAAS_WEBHOOK_TOKEN)=' .env.example > .env
  {
    echo "PORT=$PORTA"
    echo "APP_URL=https://$DOMINIO"
    echo "DATA_DIR=$APP_DIR/data"
    echo "ADMIN_EMAIL=$ADM_EMAIL"
    printf 'ADMIN_PASSWORD="%s"\n' "$ADM_PASS"
    echo "WEBHOOK_SECRET=$(openssl rand -hex 24)"
    echo "ASAAS_WEBHOOK_TOKEN=$(openssl rand -hex 24)"
  } >> .env
  chmod 600 .env
  echo "   .env criado. Depois de entrar no sistema, apague ADMIN_PASSWORD do .env."
fi

echo "==> pm2"
YUV_NODE="$NODE_DIR/bin/node" pm2 startOrReload deploy/ecosystem.config.js --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

echo "==> nginx"
cat > /etc/nginx/sites-available/yuv-financeiro <<NGINX
server {
  server_name $DOMINIO;
  client_max_body_size 12m;
  location / {
    proxy_pass http://127.0.0.1:$PORTA;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/yuv-financeiro /etc/nginx/sites-enabled/yuv-financeiro
nginx -t && systemctl reload nginx

echo "==> HTTPS (certbot)"
certbot --nginx -d "$DOMINIO" -m "$EMAIL" --agree-tos --non-interactive --redirect

echo "==> Backup diário às 03:15"
CRON="15 3 * * * cd $APP_DIR && $NODE_DIR/bin/node --env-file=.env scripts/backup.js >> $APP_DIR/data/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'yuv-financeiro\|scripts/backup.js' ; echo "$CRON # yuv-financeiro" ) | crontab -

echo
echo "Pronto: https://$DOMINIO"
echo "Agora edite $APP_DIR/.env: BILLING_PROVIDER=asaas, ASAAS_API_KEY (sandbox primeiro) e SMTP_URL."
echo "Depois: pm2 restart yuv-financeiro --update-env"
echo "Depois, no sistema: menu lateral > Integração Asaas > Cadastrar webhook (ou cadastre à mão:"
echo "  URL https://$DOMINIO/api/webhooks/asaas, token $(grep ^ASAAS_WEBHOOK_TOKEN= .env | cut -d= -f2))"
