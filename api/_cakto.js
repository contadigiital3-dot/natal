const crypto = require('crypto');
const QRCode = require('qrcode');

const CAKTO_BASE_URL = (process.env.CAKTO_API_URL || 'https://api.cakto.com.br').replace(/\/+$/, '');

let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Obtém o access_token OAuth2 da Cakto em POST /public_api/token/
 */
async function getAccessToken() {
  const directToken = (process.env.CAKTO_ACCESS_TOKEN || process.env.CAKTO_BEARER_TOKEN || '').trim();
  if (directToken) return directToken;

  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  let clientId = (
    process.env.CAKTO_CLIENT_ID ||
    process.env.CLIENT_ID ||
    process.env.CAKTO_PUBLIC_KEY ||
    ''
  ).trim();

  let clientSecret = (
    process.env.CAKTO_CLIENT_SECRET ||
    process.env.CLIENT_SECRET ||
    process.env.CAKTO_SECRET_KEY ||
    process.env.CAKTO_API_KEY ||
    ''
  ).trim();

  // Caso o usuário tenha colado "client_id:client_secret" em uma única variável
  if (!clientId && clientSecret.includes(':')) {
    const parts = clientSecret.split(':');
    clientId = parts[0].trim();
    clientSecret = parts.slice(1).join(':').trim();
  }

  if (!clientId || !clientSecret) {
    const err = new Error(
      'Credenciais da Cakto não configuradas na Vercel. Defina CAKTO_CLIENT_ID e CAKTO_CLIENT_SECRET nas Environment Variables.'
    );
    err.status = 500;
    throw err;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret
  }).toString();

  const res = await fetch(`${CAKTO_BASE_URL}/public_api/token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(
      data.detail || data.error_description || data.error || `Falha ao autenticar na API Cakto (HTTP ${res.status}).`
    );
    err.status = res.status || 500;
    throw err;
  }

  cachedToken = data.access_token;
  const expiresInSec = Number(data.expires_in) || 900;
  cachedTokenExpiresAt = now + Math.max(expiresInSec - 60, 60) * 1000;
  return cachedToken;
}

/**
 * Gera um CPF válido de 11 dígitos determinístico a partir do e-mail caso o cliente informe apenas o e-mail
 */
function generateDeterministicCpf(seedStr) {
  const hash = crypto.createHash('sha256').update(String(seedStr || 'cliente')).digest();
  const digits = [];
  for (let i = 0; i < 9; i++) {
    digits.push(hash[i] % 10);
  }
  // Evita todos os dígitos iguais
  if (digits.every(d => d === digits[0])) {
    digits[8] = (digits[0] + 1) % 10;
  }

  // 1º dígito verificador
  let sum1 = 0;
  for (let i = 0; i < 9; i++) sum1 += digits[i] * (10 - i);
  let d1 = 11 - (sum1 % 11);
  if (d1 >= 10) d1 = 0;
  digits.push(d1);

  // 2º dígito verificador
  let sum2 = 0;
  for (let i = 0; i < 10; i++) sum2 += digits[i] * (11 - i);
  let d2 = 11 - (sum2 % 11);
  if (d2 >= 10) d2 = 0;
  digits.push(d2);

  return digits.join('');
}

/**
 * Gera telefone celular brasileiro válido determinístico (55 + DDD + 9 + 8 dígitos)
 */
function generateDeterministicPhone(seedStr) {
  const hash = crypto.createHash('sha256').update('phone:' + String(seedStr || 'cliente')).digest();
  const ddds = ['11', '21', '31', '41', '51', '61', '71', '81', '85', '19', '27', '47', '48'];
  const ddd = ddds[hash[0] % ddds.length];
  let num = '9';
  for (let i = 1; i <= 8; i++) {
    num += String(hash[i] % 10);
  }
  return `55${ddd}${num}`;
}

/**
 * Extrai um nome e sobrenome limpos a partir do e-mail quando apenas o e-mail é solicitado no checkout
 */
function deriveNameFromEmail(email, providedName) {
  if (providedName && String(providedName).trim().length >= 3) {
    const clean = String(providedName).trim();
    return clean.includes(' ') ? clean : `${clean} Silva`;
  }
  const local = String(email || 'cliente@email.com')
    .split('@')[0]
    .replace(/[^a-zA-ZÀ-ÿ\s._-]/g, ' ')
    .replace(/[._-]+/g, ' ')
    .trim();

  const words = local
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  if (words.length >= 2) return `${words[0]} ${words[1]}`;
  if (words.length === 1) return `${words[0]} Silva`;
  return 'Cliente Aplicativo';
}

/**
 * Lista ofertas ativas na conta Cakto como fallback caso o ID curto tenha mudado
 */
async function findActiveOfferByPrice(token, targetPrice) {
  try {
    const res = await fetch(`${CAKTO_BASE_URL}/public_api/offers/?status=active`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const results = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
    if (!results.length) return null;

    const exact = results.find(o => Math.abs(Number(o.price) - Number(targetPrice)) < 0.5);
    if (exact && exact.id) return exact.id;
    return results[0].id || null;
  } catch {
    return null;
  }
}

/**
 * Cria cobrança Pix transacional na Cakto (POST /public_api/payments/)
 */
async function createPixCharge({ plan, email, name, phone, cpf, fingerprint, metadata, ip }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    const err = new Error('Por favor, digite um e-mail válido para receber o acesso ao aplicativo.');
    err.status = 400;
    throw err;
  }

  const isBasic = String(plan || '').toLowerCase() === 'basico' || String(plan) === '10';
  const targetPrice = isBasic ? 10 : 18;

  const candidateOffers = isBasic
    ? [
        process.env.CAKTO_OFFER_ID_10,
        process.env.CAKTO_OFFER_BASICO,
        'jrt32bg',
        'jrt32bg_1292489'
      ]
    : [
        process.env.CAKTO_OFFER_ID_18,
        process.env.CAKTO_OFFER_COMPLETO,
        '3zg3ztg',
        '3zg3ztg_1282133'
      ];

  const uniqueOffers = [...new Set(candidateOffers.map(x => String(x || '').trim()).filter(Boolean))];

  const customerName = deriveNameFromEmail(cleanEmail, name);
  const customerCpf = String(cpf || '').replace(/\D/g, '');
  const validCpf = customerCpf.length === 11 ? customerCpf : generateDeterministicCpf(cleanEmail);

  const rawPhone = String(phone || '').replace(/\D/g, '');
  const validPhone =
    rawPhone.length >= 10
      ? rawPhone.startsWith('55')
        ? rawPhone
        : `55${rawPhone}`
      : generateDeterministicPhone(cleanEmail);

  const validFingerprint =
    fingerprint && String(fingerprint).trim().startsWith('fp_')
      ? String(fingerprint).trim()
      : `fp_${crypto.randomUUID()}`;

  const customerPayload = {
    name: customerName,
    email: cleanEmail,
    phone: validPhone,
    fingerprint: validFingerprint,
    docType: 'cpf',
    docNumber: validCpf
  };

  if (ip && typeof ip === 'string') {
    const firstIp = ip.split(',')[0].trim();
    if (firstIp && firstIp !== '::1' && firstIp !== '127.0.0.1') {
      customerPayload.ip = firstIp;
    }
  }

  const token = await getAccessToken();

  async function tryCreateWithOffer(offerId) {
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      paymentMethod: 'pix',
      customer: customerPayload,
      items: [
        {
          offerId,
          quantity: 1,
          offerType: 'main'
        }
      ]
    };

    if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
      payload.metadata = metadata;
    }

    const res = await fetch(`${CAKTO_BASE_URL}/public_api/payments/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  let lastResult = null;
  for (const offerId of uniqueOffers) {
    lastResult = await tryCreateWithOffer(offerId);
    if (lastResult.ok && lastResult.data?.pix?.qrCode) {
      break;
    }
    // Se o erro for especificamente de oferta não encontrada, tenta o próximo candidato
    const itemsError = JSON.stringify(lastResult.data?.items || lastResult.data || '').toLowerCase();
    const isOfferError =
      lastResult.status === 400 &&
      (itemsError.includes('oferta') || itemsError.includes('offer') || itemsError.includes('items'));
    if (!isOfferError) {
      break;
    }
  }

  // Último fallback automático: busca ofertas ativas na conta Cakto pelo preço
  if (!lastResult?.ok) {
    const itemsError = JSON.stringify(lastResult?.data?.items || lastResult?.data || '').toLowerCase();
    if (
      lastResult?.status === 400 &&
      (itemsError.includes('oferta') || itemsError.includes('offer') || itemsError.includes('items'))
    ) {
      const discoveredOfferId = await findActiveOfferByPrice(token, targetPrice);
      if (discoveredOfferId && !uniqueOffers.includes(discoveredOfferId)) {
        lastResult = await tryCreateWithOffer(discoveredOfferId);
      }
    }
  }

  if (!lastResult || !lastResult.ok || !lastResult.data?.pix?.qrCode) {
    const detail =
      lastResult?.data?.detail ||
      (Array.isArray(lastResult?.data?.items) ? lastResult.data.items.join(' ') : null) ||
      (Array.isArray(lastResult?.data?.paymentMethod) ? lastResult.data.paymentMethod.join(' ') : null) ||
      JSON.stringify(lastResult?.data || {});
    const err = new Error(`Não foi possível gerar o Pix na Cakto: ${detail}`);
    err.status = lastResult?.status || 500;
    err.details = lastResult?.data;
    throw err;
  }

  const payment = lastResult.data;
  const brCode = payment.pix.qrCode;

  // Gera a imagem do QR Code em Base64 (Data URL) a partir de pix.qrCode conforme exigido pela documentação Cakto
  const qrCodeImage = await QRCode.toDataURL(brCode, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 340,
    color: {
      dark: '#14532d',
      light: '#ffffff'
    }
  });

  return {
    id: payment.id,
    refId: payment.refId,
    status: payment.status || 'waiting_payment',
    amount: payment.amount || (isBasic ? '10.00' : '18.00'),
    qrCode: brCode,
    qrCodeImage,
    expirationDate: payment.pix.expirationDate || null,
    checkoutUrl: payment.checkoutUrl || null
  };
}

/**
 * Consulta status do pedido na Cakto (GET /public_api/orders/{id}/)
 */
async function checkOrderStatus(orderId) {
  const cleanId = String(orderId || '').trim();
  if (!cleanId || !/^[a-zA-Z0-9_-]{4,64}$/.test(cleanId)) {
    const err = new Error('ID do pedido inválido.');
    err.status = 400;
    throw err;
  }

  const token = await getAccessToken();
  const res = await fetch(`${CAKTO_BASE_URL}/public_api/orders/${encodeURIComponent(cleanId)}/`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || `Erro ao consultar pedido (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }

  const status = String(data.status || 'waiting_payment').toLowerCase();
  const isPaid = status === 'paid' || status === 'approved' || status === 'completed';

  return {
    id: data.id || cleanId,
    refId: data.refId || null,
    status,
    isPaid,
    paidAt: data.paidAt || null
  };
}

module.exports = {
  createPixCharge,
  checkOrderStatus
};
