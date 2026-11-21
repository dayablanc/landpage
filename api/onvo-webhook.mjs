// ADD HR — Webhook de ONVO Pay (pagos de infoproductos)
// Cada pago exitoso (evento checkout_session.succeeded) se anota en la pestaña "Pagos" del
// tracker y se le avisa a Dayana por correo. Decisión de Dayana (2026-11-21): los pagos con
// ONVO llevan firma verificada, así que la entrega del infoproducto podrá ser automática; la
// regla de "confirmar depósito a mano" queda solo para SINPE y transferencias. La entrega
// todavía no existe: hoy el webhook solo registra y avisa.
//
// Es .mjs (y no .js como el bot de WhatsApp) para usar la firma web de Vercel: es la única
// forma documentada de recibir el cuerpo crudo, y la firma de ONVO se calcula sobre ese cuerpo.
//
// Variables de entorno requeridas (configurar en Vercel → Project Settings → Environment Variables):
//   ONVO_WEBHOOK_SECRET_TEST    - secreto de firma (whsec_...) del webhook en modo prueba
//   ONVO_WEBHOOK_SECRET_LIVE    - secreto de firma (whsec_...) del webhook en modo producción.
//                                  ONVO crea un endpoint distinto por modo, cada uno con su secreto.
//   ONVO_SECRET_KEY_TEST        - llave secreta de ONVO en modo prueba (para buscar nombre y correo
//   ONVO_SECRET_KEY_LIVE          del cliente: el evento solo trae el id del cliente)
//   SMTP_USER                   - correo que envía los avisos (info@addhrlatam.com)
//   SMTP_PASSWORD               - contraseña de aplicación de Google de ese correo (no la normal)
//   PAGOS_NOTIFY_EMAIL          - correo de Dayana donde llegan los avisos de pago
//   GOOGLE_SERVICE_ACCOUNT_JSON - el mismo del webhook de WhatsApp
//   LEADS_SHEET_ID              - el mismo del webhook de WhatsApp (la pestaña "Pagos" vive ahí)
//
// Detalle completo del diseño: add-hr-wat-framework/workflows/pagos_onvo.md

import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import googleAuthLibrary from 'google-auth-library';

const { GoogleAuth } = googleAuthLibrary;

const ONVO_API = 'https://api.onvopay.com/v1';

// Pestaña del tracker: no renombrarla sin cambiar esta constante
const PAGOS_TAB = 'Pagos';

// ONVO espera respuesta en 10 s; cada llamada externa tiene su propio límite para no pasarse
// (peor caso: 2 s Google + 2 s columna J en paralelo con ONVO + 2 s fila + 3 s correo = 9 s,
// sin contar el arranque en frío de la función)
const FETCH_TIMEOUT_MS = 2000;
const NOTIFY_TIMEOUT_MS = 3000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: más de ${ms} ms`)), ms)),
  ]);
}

// Encabezado X-Onvo-Signature: "t=<segundos>,v1=<hmac>" (puede traer dos v1 si se está
// rotando el secreto). Se firma "t.cuerpo" con HMAC-SHA256 y se rechazan firmas de más de 5 min.
function verifySignature(header, rawBody, secret) {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return signatures.some((sig) => {
    const received = Buffer.from(sig, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}

// Devuelve el modo ("test" o "live") cuyo secreto valida la firma, o null si ninguno
function signatureMode(header, rawBody) {
  if (verifySignature(header, rawBody, process.env.ONVO_WEBHOOK_SECRET_TEST)) return 'test';
  if (verifySignature(header, rawBody, process.env.ONVO_WEBHOOK_SECRET_LIVE)) return 'live';
  return null;
}

// El evento solo trae customerId; nombre y correo se piden a la API de ONVO
async function getCustomer(customerId, mode) {
  if (!customerId) return {};
  const key = mode === 'live' ? process.env.ONVO_SECRET_KEY_LIVE : process.env.ONVO_SECRET_KEY_TEST;
  try {
    const res = await fetch(`${ONVO_API}/customers/${encodeURIComponent(customerId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('Error buscando el cliente en ONVO:', await res.text());
      return {};
    }
    const { name, email } = await res.json();
    return { name, email };
  } catch (err) {
    console.error('Error buscando el cliente en ONVO:', err);
    return {};
  }
}

async function getGoogleAccessToken() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

// Fechas como número de serie de Sheets en hora de Costa Rica (UTC-6), igual que el bot
function sheetsSerial(date) {
  return (date.getTime() - 6 * 3600 * 1000) / 86400000 + 25569;
}

function sheetsRange(tab, cols) {
  return encodeURIComponent(`'${tab}'!${cols}`);
}

// ONVO entrega cada evento al menos una vez; la columna J guarda el id del evento para no
// anotar ni avisar el mismo pago dos veces
async function isDuplicateEvent(token, eventId) {
  try {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${process.env.LEADS_SHEET_ID}/values/${sheetsRange(PAGOS_TAB, 'J:J')}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!res.ok) return false;
    const { values = [] } = await res.json();
    return values.some(([cell]) => cell === eventId);
  } catch (err) {
    console.error('Error leyendo la pestaña Pagos del tracker:', err);
    return false;
  }
}

// Devuelve true si la fila quedó escrita
async function appendPayment(token, row) {
  try {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${process.env.LEADS_SHEET_ID}/values/${sheetsRange(PAGOS_TAB, 'A:K')}:append?valueInputOption=RAW`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [row] }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      console.error('Error escribiendo en la pestaña Pagos del tracker:', await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Error escribiendo en la pestaña Pagos del tracker:', err);
    return false;
  }
}

// Formato de Costa Rica: 500000 céntimos se muestra como "₡5 000,00". Se arma a mano porque
// toLocaleString depende de los datos de idioma del servidor
function formatAmount(amount, currency) {
  const symbol = currency === 'USD' ? '$' : '₡';
  const [whole, cents] = amount.toFixed(2).split('.');
  return `${symbol}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${cents}`;
}

// Devuelve true si el correo salió
async function notifyDayana(payment, recorded) {
  const missing = ['PAGOS_NOTIFY_EMAIL', 'SMTP_USER', 'SMTP_PASSWORD'].filter((v) => !process.env[v]);
  if (missing.length) {
    console.error('Aviso de pago sin enviar, faltan variables:', missing.join(', '));
    return false;
  }
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: NOTIFY_TIMEOUT_MS,
    greetingTimeout: NOTIFY_TIMEOUT_MS,
    socketTimeout: NOTIFY_TIMEOUT_MS,
  });
  const prueba = payment.mode === 'test' ? '[PRUEBA] ' : '';
  try {
    await withTimeout(transporter.sendMail({
      from: `ADD HR Pagos <${process.env.SMTP_USER}>`,
      to: process.env.PAGOS_NOTIFY_EMAIL,
      subject: `${prueba}Nuevo pago: ${formatAmount(payment.amount, payment.currency)} · ${payment.product}`,
      text:
        `${prueba}Recibiste un pago por ONVO.\n\n` +
        `Producto: ${payment.product}\n` +
        `Monto: ${formatAmount(payment.amount, payment.currency)}\n` +
        `Cliente: ${payment.customerName || 'Sin nombre'}\n` +
        `Correo: ${payment.customerEmail || 'Sin correo'}\n` +
        (payment.notes ? `Notas: ${payment.notes}\n` : '') +
        '\n' +
        (recorded
          ? 'Quedó anotado en la pestaña Pagos del tracker de leads.'
          : 'NO quedó anotado en el tracker (falló Google): busca el ID evento en la columna J y, si no está, anótalo a mano en la pestaña Pagos.') +
        `\nID evento: ${payment.eventId}`,
    }), NOTIFY_TIMEOUT_MS, 'Correo de aviso');
    return true;
  } catch (err) {
    console.error('Error enviando aviso de pago a Dayana:', err);
    return false;
  }
}

export async function POST(request) {
  const rawBody = await request.text();
  const signatureModeFound = signatureMode(request.headers.get('x-onvo-signature'), rawBody);
  if (!signatureModeFound) {
    console.error('Aviso de ONVO con firma inválida: se descarta. Largo del cuerpo:', rawBody.length);
    return new Response('Invalid signature', { status: 400 });
  }

  try {
    const event = JSON.parse(rawBody);

    // El botón "Probar conexión" de ONVO manda webhook_endpoint.test: basta con responder 200
    if (event.type !== 'checkout_session.succeeded') {
      return new Response('OK', { status: 200 });
    }

    const notes = [];
    // Si el modo del evento no coincide con el secreto que validó, se confía en el evento:
    // así un secreto real pegado por error en la variable de prueba no esconde un pago real
    let mode = signatureModeFound;
    if (event.mode && event.mode !== signatureModeFound) {
      if (event.mode === 'test' || event.mode === 'live') {
        notes.push(`modo no coincide (firma ${signatureModeFound}, evento ${event.mode})`);
        mode = event.mode;
      } else {
        notes.push(`modo desconocido: ${event.mode}`);
      }
    }

    const session = event.data?.object || {};
    if (session.paymentStatus) notes.push(`paymentStatus: ${session.paymentStatus}`);

    // Si Google falla, se avisa igual por correo: es preferible un pago sin anotar a uno sin avisar.
    // La consulta del cliente a ONVO corre en paralelo para ahorrar tiempo.
    const googleReady = withTimeout(getGoogleAccessToken(), FETCH_TIMEOUT_MS, 'Autenticación con Google')
      .catch((err) => {
        console.error('Error autenticando con Google:', err);
        return null;
      })
      .then(async (token) => ({ token, duplicate: token ? await isDuplicateEvent(token, event.id) : false }));
    const [{ token: googleToken, duplicate }, customer] = await Promise.all([
      googleReady,
      getCustomer(session.customerId, mode),
    ]);

    if (duplicate) {
      return new Response('OK', { status: 200 });
    }

    if (session.customerId && !customer.email) notes.push('cliente sin correo en ONVO');

    const payment = {
      mode,
      // Los montos vienen en céntimos: 500000 = ₡5 000,00
      amount: (session.amountTotal || 0) / 100,
      currency: session.currency || 'CRC',
      // El nombre del producto viaja en metadata.producto al crear el link de pago
      product: session.metadata?.producto || 'Sin producto (falta metadata.producto)',
      customerName: customer.name,
      customerEmail: customer.email,
      notes: notes.join(' · '),
      eventId: event.id,
    };

    const eventDate = new Date(event.createdAt);
    const recorded = googleToken
      ? await appendPayment(googleToken, [
          sheetsSerial(Number.isNaN(eventDate.getTime()) ? new Date() : eventDate),
          mode === 'live' ? 'Real' : 'Prueba',
          payment.product,
          payment.amount,
          payment.currency,
          payment.customerName || '',
          payment.customerEmail || '',
          session.id || '',
          session.paymentIntentId || '',
          event.id,
          payment.notes,
        ])
      : false;

    const notified = await notifyDayana(payment, recorded);

    // Si no quedó ni anotado ni avisado, se responde 500 para que ONVO reintente más tarde
    // (el control por ID evento evita duplicar la fila cuando el reintento sí funcione)
    if (!recorded && !notified) {
      return new Response('Retry later', { status: 500 });
    }
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Error procesando aviso de ONVO:', err);
    // La firma ya era válida: un error inesperado puede ser pasajero, así que ONVO reintenta
    return new Response('Retry later', { status: 500 });
  }
}
