const crypto = require('crypto');

function parseYouTubeId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let url;
  try {
    url = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    if (url.searchParams.get('v')) id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

function formatDuration(seconds) {
  if (seconds == null) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function formatDate(d, withTime = true) {
  if (!d) return '—';
  const date = new Date(d);
  const opts = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: process.env.TZ || 'America/Sao_Paulo' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString('pt-BR', opts);
}

function daysBetween(a, b) {
  return (new Date(b) - new Date(a)) / 86400000;
}

function randomCode(len = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function randomPassword() {
  return crypto.randomBytes(6).toString('base64url');
}

function toInt(v, fallback = null) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function checkbox(v) {
  return v === 'on' || v === 'true' || v === '1' || v === true;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  // separador ";" abre direto no Excel em pt-BR
  return '﻿' + [header, ...rows].map((r) => r.map(csvEscape).join(';')).join('\n');
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

module.exports = {
  parseYouTubeId, formatDuration, formatDate, daysBetween, randomCode, randomPassword,
  toInt, checkbox, toCsv, normalizePhone,
};
