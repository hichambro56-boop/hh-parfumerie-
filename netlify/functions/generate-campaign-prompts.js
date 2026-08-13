// netlify/functions/generate-campaign-prompts.js
//
// Étape 1 seule (rapide, <10s) : Claude analyse le produit + la photo et
// renvoie les 3 prompts, dans un ordre fixe : packaging, notes, lifestyle.
//
// Entrée (JSON, POST) :
//   { "product": { "brand", "name", "family", "notes"?, "price"? },
//     "image": "data:image/png;base64,AAAA..." }
//
// Sortie :
//   succès -> { success: true, prompts: [p1,p2,p3], slots: [label1,label2,label3] }
//   erreur -> { success: false, step: "claude"|"input", error: "..." }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-5';

const CAMPAIGN_SLOTS = [
  { key: 'packaging', label: 'PERFUME + PACKAGING' },
  { key: 'notes', label: 'PERFUME + NOTES' },
  { key: 'lifestyle', label: 'SUMMER / BEACH / LIFESTYLE' },
];

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

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '```').trim();
  const fencedMatch = cleaned.match(/```([\s\S]*?)```/);
  const candidate = fencedMatch ? fencedMatch[1].trim() : cleaned;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Impossible de trouver un objet JSON dans la réponse de Claude.');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function getPromptsFromClaude({ apiKey, product, imageBase64, imageMimeType }) {
  console.log('[generate-campaign-prompts] Appel Claude', {
    brand: product.brand,
    name: product.name,
    family: product.family,
  });

  const systemPrompt = [
    'Tu es directeur artistique pour des campagnes marketing de parfums de luxe.',
    'On te donne la photo réelle d\'un flacon de parfum et ses informations.',
    'Rédige EXACTEMENT 3 prompts en anglais, pour OpenAI image-editing (gpt-image-1),',
    'dans cet ordre précis et fixe :',
    '1) "packaging" — flacon posé à côté de sa boîte, studio shot épuré, lumière produit professionnelle.',
    '2) "notes" — le flacon mis en scène avec les ingrédients olfactifs évoqués (fleurs, agrumes, épices, bois selon les notes fournies).',
    '3) "lifestyle" — mise en scène estivale/plage/vacances, ambiance ensoleillée, ombres douces, decor naturel.',
    'Chaque prompt doit explicitement exiger de conserver fidèlement le flacon et son étiquette',
    'tels qu\'ils apparaissent sur la photo fournie (forme, couleur, texte inchangés) — seul le décor change.',
    'Réponds UNIQUEMENT avec un JSON strict :',
    '{"prompts": {"packaging": "...", "notes": "...", "lifestyle": "..."}}',
    'Sans aucun texte avant/après, sans balises markdown.',
  ].join(' ');

  const userText = [
    `Marque : ${product.brand || 'N/A'}`,
    `Nom du produit : ${product.name || 'N/A'}`,
    product.family ? `Catégorie : ${product.family}` : null,
    product.notes ? `Notes olfactives : ${product.notes}` : null,
    product.price ? `Prix : ${product.price}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } },
            { type: 'text', text: userText || 'Analyse ce parfum et génère les 3 prompts demandés.' },
          ],
        },
      ],
    }),
  });

  const rawText = await response.text();

  if (!response.ok) {
    console.error('[generate-campaign-prompts] Claude error', response.status, rawText);
    const err = new Error(`Claude API error (${response.status}): ${rawText}`);
    err.step = 'claude';
    throw err;
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.error('[generate-campaign-prompts] Claude response not JSON', rawText);
    const err = new Error('Réponse Claude illisible (pas du JSON valide).');
    err.step = 'claude';
    throw err;
  }

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) {
    const err = new Error('Claude n\'a renvoyé aucun bloc texte exploitable.');
    err.step = 'claude';
    throw err;
  }

  let parsed;
  try {
    parsed = extractJson(textBlock.text);
  } catch (e) {
    console.error('[generate-campaign-prompts] Cannot parse Claude JSON', textBlock.text);
    const err = new Error(`Impossible de parser les prompts Claude: ${e.message}`);
    err.step = 'claude';
    throw err;
  }

  const promptsObj = parsed.prompts || {};
  const prompts = CAMPAIGN_SLOTS.map((slot) => promptsObj[slot.key]);

  if (prompts.some((p) => !p || typeof p !== 'string')) {
    console.error('[generate-campaign-prompts] Missing prompt(s)', promptsObj);
    const err = new Error(`Claude devait renvoyer les 3 prompts (packaging, notes, lifestyle). Reçu: ${JSON.stringify(promptsObj)}`);
    err.step = 'claude';
    throw err;
  }

  console.log('[generate-campaign-prompts] OK:', prompts);
  return prompts;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(200, {});
  if (event.httpMethod !== 'POST') {
    return respond(405, { success: false, step: 'input', error: 'Méthode non autorisée, POST attendu.' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    console.error('[generate-campaign-prompts] Missing ANTHROPIC_API_KEY env var.');
    return respond(500, { success: false, step: 'input', error: 'ANTHROPIC_API_KEY absente des variables d\'environnement Netlify.' });
  }

  let payload;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    return respond(400, { success: false, step: 'input', error: 'Corps de requête JSON invalide.' });
  }

  const product = payload.product || {
    brand: payload.brand,
    name: payload.name,
    notes: payload.notes,
    price: payload.price,
    family: payload.family || payload.category,
  };
  const imageInput = payload.image;

  if (!product || !product.name) {
    return respond(400, { success: false, step: 'input', error: 'Informations produit manquantes (product.name requis).' });
  }
  if (!imageInput) {
    return respond(400, { success: false, step: 'input', error: 'Image du produit manquante (champ "image").' });
  }

  let imageMimeType, imageBase64;
  try {
    const parsed = parseDataUri(imageInput);
    imageMimeType = parsed.mimeType;
    imageBase64 = parsed.base64;
  } catch (e) {
    return respond(400, { success: false, step: 'input', error: `Image invalide: ${e.message}` });
  }

  try {
    const prompts = await getPromptsFromClaude({ apiKey: ANTHROPIC_API_KEY, product, imageBase64, imageMimeType });
    return respond(200, {
      success: true,
      prompts,
      slots: CAMPAIGN_SLOTS.map((s) => s.label),
    });
  } catch (e) {
    console.error('[generate-campaign-prompts] Failed', e);
    return respond(502, { success: false, step: e.step || 'claude', error: e.message || String(e) });
  }
};
