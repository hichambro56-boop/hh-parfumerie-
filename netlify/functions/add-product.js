// netlify/functions/add-product.js
//
// Ajoute un produit au fichier data/products.json du dépôt GitHub via
// l'API GitHub (Contents API). Comme le site est connecté à GitHub,
// Netlify redéploie automatiquement dès que ce fichier change — le
// nouveau produit apparaît sur le site en 1-2 minutes, sans toucher au
// code de index.html.
//
// Entrée (JSON, POST) :
//   {
//     "brand": "...", "name": "...", "notes": "...",
//     "price": "299 MAD", "oldPrice": "449 MAD" (optionnel),
//     "family": "homme"|"femme"|"unisexe"|"pack",
//     "image": "data:image/jpeg;base64,AAAA..."
//   }
//
// Variables d'environnement requises (Netlify > Environment variables) :
//   GITHUB_TOKEN   — Personal Access Token GitHub avec accès "repo" (write)
//
// Si le nom du dépôt ou le propriétaire changent, modifie les deux
// constantes ci-dessous.
const GITHUB_OWNER = 'hichambro56-boop';
const GITHUB_REPO = 'hh-parfumerie-';
const GITHUB_BRANCH = 'main';
const PRODUCTS_PATH = 'data/products.json';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

const FAMILY_LABELS = {
  homme: 'Homme',
  femme: 'Femme',
  unisexe: 'Unisexe',
  pack: 'Pack',
};

// Petite palette de couleurs d'accent, choisie automatiquement au hasard
// pour chaque nouveau produit (l'utilisateur n'a pas à en choisir une).
const ACCENT_PALETTE = ['#6B1E2E', '#22303A', '#8a7452', '#C98A82', '#1a2a3a', '#5a4a2a'];

async function githubRequest(path, options = {}) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`GitHub API error (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(200, {});
  if (event.httpMethod !== 'POST') {
    return respond(405, { success: false, error: 'Méthode non autorisée, POST attendu.' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) {
    console.error('[add-product] Missing GITHUB_TOKEN env var.');
    return respond(500, { success: false, error: 'GITHUB_TOKEN absent des variables d\'environnement Netlify.' });
  }

  let payload;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    return respond(400, { success: false, error: 'Corps de requête JSON invalide.' });
  }

  const { brand, name, notes, price, oldPrice, promo, family, volume, image, photos } = payload;

  const finalPhotos = Array.isArray(photos) && photos.length ? photos : (image ? [image] : []);

  if (!name || !price || !family || !finalPhotos.length) {
    return respond(400, {
      success: false,
      error: 'Champs requis manquants (name, price, family, image ou photos).',
    });
  }
  if (!FAMILY_LABELS[family]) {
    return respond(400, { success: false, error: `Catégorie invalide: "${family}".` });
  }

  const fullName = brand ? `${brand} ${name}`.trim() : name;
  const accent = ACCENT_PALETTE[Math.floor(Math.random() * ACCENT_PALETTE.length)];

  const newProduct = {
    id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: fullName,
    family,
    label: FAMILY_LABELS[family],
    notes: notes || '',
    price,
    ...(oldPrice ? { oldPrice } : {}),
    ...(promo ? { promo } : {}),
    ...(volume ? { volume } : {}),
    accent,
    photos: finalPhotos,
    addedAt: new Date().toISOString(),
  };

  console.log('[add-product] Nouveau produit', { name: fullName, family, price });

  try {
    // 1. Lire le fichier actuel (pour avoir son sha, requis par GitHub pour update)
    let currentProducts = [];
    let sha = null;
    try {
      const fileData = await githubRequest(`contents/${PRODUCTS_PATH}?ref=${GITHUB_BRANCH}`);
      sha = fileData.sha;
      const decoded = Buffer.from(fileData.content, 'base64').toString('utf8');
      currentProducts = JSON.parse(decoded || '[]');
      if (!Array.isArray(currentProducts)) currentProducts = [];
    } catch (e) {
      if (e.status === 404) {
        console.log('[add-product] data/products.json n\'existe pas encore, il sera créé.');
      } else {
        throw e;
      }
    }

    // 2. Ajouter le nouveau produit
    currentProducts.push(newProduct);

    // 3. Écrire le fichier mis à jour sur GitHub
    const updatedContent = Buffer.from(JSON.stringify(currentProducts, null, 2), 'utf8').toString('base64');
    await githubRequest(`contents/${PRODUCTS_PATH}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Ajout produit: ${fullName}`,
        content: updatedContent,
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

    console.log('[add-product] Produit ajouté avec succès, Netlify va redéployer automatiquement.');
    return respond(200, {
      success: true,
      message: 'Produit ajouté. Le site va se mettre à jour automatiquement dans 1 à 2 minutes.',
      product: newProduct,
    });
  } catch (e) {
    console.error('[add-product] Échec', e);
    return respond(502, { success: false, error: e.message || String(e) });
  }
};
