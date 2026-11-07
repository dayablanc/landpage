// ADD HR — Webhook de WhatsApp Cloud API
// Fase 1: saluda una sola vez a cada número nuevo (para que ningún lead se quede sin
// respuesta) y lo registra en el tracker de leads. Los mensajes siguientes del mismo
// número no se vuelven a saludar ni registrar; solo se reenvían a Dayana. NO cotiza, NO confirma
// depósitos ni envía CVs — esas partes las sigue haciendo Dayana a mano.
//
// Variables de entorno requeridas (configurar en Vercel → Project Settings → Environment Variables):
//   WHATSAPP_VERIFY_TOKEN       - token inventado por Dayana, se usa solo para que Meta
//                                  verifique este webhook una vez al configurarlo
//   WHATSAPP_ACCESS_TOKEN       - access token de la app de Meta (System User token)
//   WHATSAPP_PHONE_NUMBER_ID    - ID del número de WhatsApp conectado a la Cloud API
//   DAYANA_NOTIFY_NUMBER        - número personal de Dayana para avisos, formato E.164 sin "+".
//                                  Sus propios mensajes al bot no se registran como lead.
//   NOTIFY_TEMPLATE_NAME        - (opcional) nombre de la plantilla aprobada en Meta para los
//                                  avisos (ej. "aviso_lead", idioma "es"). Sin ella el aviso va
//                                  como texto libre y solo llega si Dayana le escribió al bot en
//                                  las últimas 24 h (regla de WhatsApp).
//   GOOGLE_SERVICE_ACCOUNT_JSON - contenido completo del JSON de la cuenta de servicio de Google
//   LEADS_SHEET_ID              - ID del spreadsheet "ADD HR · Tracker de Leads"
//
// Detalle completo del diseño: add-hr-wat-framework/workflows/ventas_respuesta_leads.md

const { GoogleAuth } = require('google-auth-library');

const GRAPH_API = 'https://graph.facebook.com/v20.0';

async function sendWhatsAppMessage(to, text) {
  const res = await fetch(`${GRAPH_API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) {
    console.error('Error enviando WhatsApp:', await res.text());
  }
}

// Plantilla "aviso_lead" en Meta (Utilidad, idioma "Spanish", código es): "Tu cuenta de
// WhatsApp de ADD HR recibió un {{1}} de {{2}} (número {{3}}). Contenido del mensaje: "{{4}}".
// Revisa el registro de contactos para darle seguimiento." Meta la clasificaba como Marketing
// con palabras como "lead" o "paquete", por eso el texto es neutro. Los parámetros de plantilla no aceptan saltos de
// línea ni más de 4 espacios seguidos, por eso se limpian.
async function notifyDayana(kind, contactName, from, text) {
  const to = String(process.env.DAYANA_NOTIFY_NUMBER || '').replace(/\D/g, '');
  if (!to) return;
  const template = process.env.NOTIFY_TEMPLATE_NAME;
  const freeText = `🔔 Recibiste un ${kind} de ${contactName} (${from}):\n"${text}"\n\nRevisa el registro de contactos para darle seguimiento.`;
  if (!template) {
    await sendWhatsAppMessage(to, freeText);
    return;
  }
  const clean = (value, max) => String(value).replace(/\s+/g, ' ').trim().slice(0, max);
  const res = await fetch(`${GRAPH_API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: 'es' },
        components: [
          {
            type: 'body',
            parameters: [kind, contactName, from, text].map((value, i) => ({
              type: 'text',
              text: clean(value, i === 3 ? 500 : 60),
            })),
          },
        ],
      },
    }),
  });
  if (!res.ok) {
    // Respaldo: el texto libre solo llega si Dayana le escribió al bot en las últimas 24 h
    console.error('Error enviando aviso a Dayana:', await res.text());
    await sendWhatsAppMessage(to, freeText);
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

// La columna L del tracker guarda el teléfono; sirve para saber si el número ya escribió antes
async function isKnownLead(token, phone) {
  const sheetId = process.env.LEADS_SHEET_ID;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/L:L`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    console.error('Error leyendo el tracker de leads:', await res.text());
    return false;
  }
  const { values = [] } = await res.json();
  return values.some(([cell]) => String(cell || '').replace(/\D/g, '') === phone);
}

async function appendLeadRow(token, row) {
  const sheetId = process.env.LEADS_SHEET_ID;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:L:append?valueInputOption=RAW`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    }
  );
  if (!res.ok) {
    console.error('Error escribiendo en el tracker de leads:', await res.text());
  }
}

const MENSAJE_BIENVENIDA =
  '¡Hola! Soy el asistente de Dayana (ADD HR) 👋 Ya recibí tu mensaje y en breve te ' +
  'escribe ella personalmente. Mientras tanto, cuéntame rápido: ¿cuál es tu situación ' +
  'actual? (por ejemplo: "llevo 2 meses sin empleo", "tengo entrevista la próxima ' +
  'semana", "busco mi primer empleo"). Así Dayana te recomienda el paquete que mejor te sirve.\n\n' +
  'Tus datos se tratan según nuestra política de privacidad: ' +
  'https://dayablancohr.vercel.app/privacidad.html';

module.exports = async (req, res) => {
  // Meta llama con GET una sola vez para verificar el webhook al configurarlo
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];

    if (!message) {
      // Eventos que no son mensajes entrantes (confirmaciones de entrega, etc.)
      return res.status(200).send('OK');
    }

    const from = message.from;
    const contactName = change?.contacts?.[0]?.profile?.name || 'Sin nombre';
    const text = message.text?.body || '[mensaje sin texto: audio, imagen u otro adjunto]';
    const now = new Date().toISOString();

    // Los mensajes de Dayana al bot (por ejemplo, para abrir la ventana de 24 h) no son leads
    if (from === String(process.env.DAYANA_NOTIFY_NUMBER || '').replace(/\D/g, '')) {
      return res.status(200).send('OK');
    }

    // Si Google falla, se saluda igual: es preferible un saludo repetido a un lead sin respuesta
    let googleToken = null;
    try {
      googleToken = await getGoogleAccessToken();
    } catch (err) {
      console.error('Error autenticando con Google:', err);
    }

    if (googleToken && (await isKnownLead(googleToken, from))) {
      await notifyDayana('mensaje de seguimiento', contactName, from, text);
      return res.status(200).send('OK');
    }

    await sendWhatsAppMessage(from, MENSAJE_BIENVENIDA);

    if (googleToken) await appendLeadRow(googleToken, [
      now,
      contactName,
      'WhatsApp',
      text,
      '',
      'Contactado (auto)',
      'Dayana revisa y recomienda paquete',
      '',
      'No',
      'No',
      'Creado automáticamente por el webhook',
      from,
    ]);

    await notifyDayana('primer mensaje', contactName, from, text);

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error procesando mensaje de WhatsApp:', err);
    // Responder 200 igual para que Meta no reintente de más
    return res.status(200).send('OK');
  }
};
