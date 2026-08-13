// netlify/functions/generate-campaign.js
//
// Pipeline complet :
//   1) Claude (ANTHROPIC_API_KEY) reçoit la photo du parfum + ses infos et
//      rédige 3 prompts, TOUJOURS dans cet ordre fixe :
//        [0] PERFUME + PACKAGING   (flacon + boîte, studio)
//        [1] PERFUME + NOTES        (flacon entouré des ingrédients/notes)
//        [2] SUMMER / BEACH / LIFESTYLE (mise en scène estivale)
//   2) OpenAI gpt-image-1 (OPENAI_API_KEY) édite la photo originale avec
//      chacun de ces 3 prompts, en parallèle, et renvoie 3 images réelles.
//   3) La fonction renvoie { success, prompts[3], images[3] } au frontend.
//
// Entrée attendue (JSON, POST) :
//   { "product": { "brand", "name", "family", "notes"?, "price"? },
//     "image": "data:image/png;base64,AAAA..." }
//
// Variables d'environnement requises (Netlify > Site settings > Environment):
//   ANTHROPIC_API_KEY
//   OPENAI_API_KEY

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_IMAGES_EDIT_URL = 'https://api.openai.com/v1/images/edits';

const CLAUDE_MODEL = 'claude-sonnet-5';

// Taille gpt-image-1 la plus proche d'un ratio 4:5 (portrait).
// Valeurs acceptées par gpt-image-1 : 1024x1024, 1024x1536, 1536x1024.
const IMAGE_SIZE = '1024x1536';

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

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Étape 1 — Claude : analyse + 3 prompts dans un ordre fixe
// ---------------------------------------------------------------------------

async function getPromptsFromClaude({ apiKey, product, imageBase64, imageMimeType }) {
  console.log('[generate-campaign] STEP 1 — Claude: analyse produit + génération des 3 prompts', {
    brand: product.brand,
    name: product.name,
    family: product.family,
    imageMimeType,
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
    console.error('[generate-campaign] Claude error', response.status, rawText);
    const err = new Error(`Claude API error (${response.status}): ${rawText}`);
    err.step = 'claude';
    throw err;
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.error('[generate-campaign] Claude response is not JSON', rawText);
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
    console.error('[generate-campaign] Cannot parse Claude prompts JSON', textBlock.text);
    const err = new Error(`Impossible de parser les prompts générés par Claude: ${e.message}`);
    err.step = 'claude';
    throw err;
  }

  const promptsObj = parsed.prompts || {};
  const prompts = CAMPAIGN_SLOTS.map((slot) => promptsObj[slot.key]);

  if (prompts.some((p) => !p || typeof p !== 'string')) {
    console.error('[generate-campaign] Missing prompt(s) in Claude response', promptsObj);
    const err = new Error(
      `Claude devait renvoyer les 3 prompts (packaging, notes, lifestyle). Reçu: ${JSON.stringify(promptsObj)}`
    );
    err.step = 'claude';
    throw err;
  }

  console.log('[generate-campaign] Claude prompts OK:', prompts);
  return prompts;
}

// ---------------------------------------------------------------------------
// Étape 2 — OpenAI gpt-image-1 : édition de l'image pour chaque prompt
// ---------------------------------------------------------------------------

async function generateOneImage({ apiKey, prompt, imageBuffer, imageMimeType, slotLabel }) {
  console.log(`[generate-campaign] STEP 2 — OpenAI: génération "${slotLabel}"`, {
    promptPreview: prompt.slice(0, 90),
  });

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('image', new Blob([imageBuffer], { type: imageMimeType }), 'product.png');
  form.append('prompt', prompt);
  form.append('size', IMAGE_SIZE);
  form.append('n', '1');

  const response = await fetch(OPENAI_IMAGES_EDIT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const rawText = await response.text();

  if (!response.ok) {
    console.error(`[generate-campaign] OpenAI error (${slotLabel})`, response.status, rawText);
    const err = new Error(`OpenAI API error (${response.status}) [${slotLabel}]: ${rawText}`);
    err.step = 'openai';
    throw err;
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    console.error(`[generate-campaign] OpenAI response is not JSON (${slotLabel})`, rawText);
    const err = new Error(`Réponse OpenAI illisible pour "${slotLabel}".`);
    err.step = 'openai';
    throw err;
  }

  const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) {
    console.error(`[generate-campaign] No b64_json from OpenAI (${slotLabel})`, data);
    const err = new Error(`OpenAI n'a renvoyé aucune image pour "${slotLabel}".`);
    err.step = 'openai';
    throw err;
  }

  console.log(`[generate-campaign] OpenAI image OK: ${slotLabel}`);
  return `data:image/png;base64,${b64}`;
}

async function generateImagesFromPrompts({ apiKey, prompts, imageBuffer, imageMimeType }) {
  const results = await Promise.allSettled(
    prompts.map((prompt, index) =>
      generateOneImage({
        apiKey,
        prompt,
        imageBuffer,
        imageMimeType,
        slotLabel: CAMPAIGN_SLOTS[index].label,
      })
    )
  );

  const images = [];
  const failures = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      images.push(result.value);
    } else {
      console.error(`[generate-campaign] Failed "${CAMPAIGN_SLOTS[index].label}":`, result.reason);
      failures.push(`${CAMPAIGN_SLOTS[index].label}: ${result.reason.message || result.reason}`);
      images.push(null);
    }
  });

  return { images, failures };
}

// ---------------------------------------------------------------------------
// Handler Netlify
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  const startedAt = Date.now();

  if (event.httpMethod === 'OPTIONS') return respond(200, {});

  if (event.httpMethod !== 'POST') {
    return respond(405, { success: false, step: 'input', error: 'Méthode non autorisée, POST attendu.' });
  }

  console.log('[generate-campaign] Requête reçue', {
    isBase64Encoded: event.isBase64Encoded,
    bodyLength: event.body ? event.body.length : 0,
  });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    console.error('[generate-campaign] Missing ANTHROPIC_API_KEY env var.');
    return respond(500, { success: false, step: 'input', error: 'ANTHROPIC_API_KEY absente des variables d\'environnement Netlify.' });
  }
  if (!OPENAI_API_KEY) {
    console.error('[generate-campaign] Missing OPENAI_API_KEY env var.');
    return respond(500, { success: false, step: 'input', error: 'OPENAI_API_KEY absente des variables d\'environnement Netlify.' });
  }

  let payload;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    console.error('[generate-campaign] Invalid JSON body', e);
    return respond(400, { success: false, step: 'input', error: 'Corps de requête JSON invalide.' });
  }

  const product = payload.product || {
    brand: payload.brand || payload.productBrand,
    name: payload.name || payload.productName,
    notes: payload.notes || payload.productNotes,
    price: payload.price || payload.productPrice,
    family: payload.family || payload.category || payload.productFamily,
  };
  const imageInput = payload.image || payload.imageBase64 || payload.photo;

  if (!product || !product.name) {
    return respond(400, { success: false, step: 'input', error: 'Informations produit manquantes (product.name requis).' });
  }
  if (!imageInput) {
    return respond(400, { success: false, step: 'input', error: 'Image du produit manquante (champ "image", data URI base64).' });
  }

  let imageMimeType, imageBase64, imageBuffer;
  try {
    const parsedImage = parseDataUri(imageInput);
    imageMimeType = parsedImage.mimeType;
    imageBase64 = parsedImage.base64;
    imageBuffer = Buffer.from(imageBase64, 'base64');
  } catch (e) {
    console.error('[generate-campaign] Invalid image', e);
    return respond(400, { success: false, step: 'input', error: `Image invalide: ${e.message}` });
  }

  // -- Étape 1 : Claude --------------------------------------------------
  let prompts;
  try {
    prompts = await getPromptsFromClaude({ apiKey: ANTHROPIC_API_KEY, product, imageBase64, imageMimeType });
  } catch (e) {
    console.error('[generate-campaign] Claude step failed', e);
    return respond(502, { success: false, step: e.step || 'claude', error: e.message || String(e) });
  }

  console.log(`[generate-campaign] Claude terminé en ${Date.now() - startedAt}ms, lancement OpenAI...`);

  // -- Étape 2 : OpenAI ----------------------------------------------------
  let images, failures;
  try {
    const result = await generateImagesFromPrompts({ apiKey: OPENAI_API_KEY, prompts, imageBuffer, imageMimeType });
    images = result.images;
    failures = result.failures;
  } catch (e) {
    console.error('[generate-campaign] OpenAI step failed', e);
    return respond(502, { success: false, step: e.step || 'openai', error: e.message || String(e) });
  }

  const successCount = images.filter(Boolean).length;
  const totalMs = Date.now() - startedAt;
  console.log(`[generate-campaign] Terminé en ${totalMs}ms — ${successCount}/3 images générées.`, { failures });

  if (successCount === 0) {
    return respond(502, { success: false, step: 'openai', error: failures.join(' | ') || 'Aucune image générée.' });
  }

  return respond(200, {
    success: true,
    prompts,
    images,
    slots: CAMPAIGN_SLOTS.map((s) => s.label),
    ...(failures.length ? { partialErrors: failures } : {}),
  });
};
