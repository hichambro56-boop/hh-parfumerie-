// netlify/functions/generate-campaign-image.js
//
// Étape 2, appelée UNE FOIS PAR IMAGE (le frontend fait 3 appels en
// parallèle, un par prompt). Chaque appel a son propre budget de temps
// Netlify (~10-26s), au lieu qu'une seule requête doive attendre les 3
// images d'affilée — c'est ce qui causait le timeout HTTP 504.
//
// Entrée (JSON, POST) :
//   { "prompt": "...", "image": "data:image/png;base64,AAAA...", "slotLabel": "..." }
//
// Sortie :
//   succès -> { success: true, image: "data:image/png;base64,..." }
//   erreur -> { success: false, step: "openai"|"input", error: "..." }

const OPENAI_IMAGES_EDIT_URL = 'https://api.openai.com/v1/images/edits';
const IMAGE_SIZE = '1024x1024'; // carré — plus rapide à générer que le portrait 1536
const IMAGE_QUALITY = 'low'; // réduit fortement le temps de génération (contrainte: timeout Netlify ~26s)

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function parseDataUri(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Image manquante ou invalide dans la requête.');
  }
  const match = input.match(/^data:(.+?);base64,(.+)$/);
  if (match) return { mimeType: match[1], base64: match[2] };
  return { mimeType: 'image/png', base64: input };
}

exports.handler = async (event) => {
  const startedAt = Date.now();

  if (event.httpMethod === 'OPTIONS') return respond(200, {});
  if (event.httpMethod !== 'POST') {
    return respond(405, { success: false, step: 'input', error: 'Méthode non autorisée, POST attendu.' });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.error('[generate-campaign-image] Missing OPENAI_API_KEY env var.');
    return respond(500, { success: false, step: 'input', error: 'OPENAI_API_KEY absente des variables d\'environnement Netlify.' });
  }

  let payload;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    return respond(400, { success: false, step: 'input', error: 'Corps de requête JSON invalide.' });
  }

  const prompt = payload.prompt;
  const imageInput = payload.image;
  const slotLabel = payload.slotLabel || 'image';

  if (!prompt) {
    return respond(400, { success: false, step: 'input', error: 'Prompt manquant.' });
  }
  if (!imageInput) {
    return respond(400, { success: false, step: 'input', error: 'Image du produit manquante (champ "image").' });
  }

  let imageMimeType, imageBuffer;
  try {
    const parsed = parseDataUri(imageInput);
    imageMimeType = parsed.mimeType;
    imageBuffer = Buffer.from(parsed.base64, 'base64');
  } catch (e) {
    return respond(400, { success: false, step: 'input', error: `Image invalide: ${e.message}` });
  }

  console.log(`[generate-campaign-image] Génération "${slotLabel}"`, { promptPreview: prompt.slice(0, 90) });

  try {
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('image', new Blob([imageBuffer], { type: imageMimeType }), 'product.png');
    form.append('prompt', prompt);
    form.append('size', IMAGE_SIZE);
    form.append('quality', IMAGE_QUALITY);
    form.append('n', '1');

    const response = await fetch(OPENAI_IMAGES_EDIT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const rawText = await response.text();

    if (!response.ok) {
      console.error(`[generate-campaign-image] OpenAI error (${slotLabel})`, response.status, rawText);
      return respond(502, { success: false, step: 'openai', error: `OpenAI API error (${response.status}) [${slotLabel}]: ${rawText}` });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error(`[generate-campaign-image] OpenAI response not JSON (${slotLabel})`, rawText);
      return respond(502, { success: false, step: 'openai', error: `Réponse OpenAI illisible pour "${slotLabel}".` });
    }

    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      console.error(`[generate-campaign-image] No b64_json (${slotLabel})`, data);
      return respond(502, { success: false, step: 'openai', error: `OpenAI n'a renvoyé aucune image pour "${slotLabel}".` });
    }

    console.log(`[generate-campaign-image] OK "${slotLabel}" en ${Date.now() - startedAt}ms`);
    return respond(200, { success: true, image: `data:image/png;base64,${b64}` });
  } catch (e) {
    console.error(`[generate-campaign-image] Exception (${slotLabel})`, e);
    return respond(502, { success: false, step: 'openai', error: e.message || String(e) });
  }
};
