// netlify/functions/delete-product.js
//
// Supprime un produit par son id, dans data/products.json (produits
// ajoutés dynamiquement) OU data/static-products.json (produits d'origine)
// — la fonction cherche dans les deux et supprime là où l'id est trouvé.
// Comme le site est connecté à GitHub, Netlify redéploie automatiquement
// dès que le fichier change.
//
// Entrée (JSON, POST) :
//   { "id": "yves-saint-laurent-libre" }
//
// Variables d'environnement requises :
//   GITHUB_TOKEN — Personal Access Token GitHub avec accès "repo" (write)

const GITHUB_OWNER = 'hichambro56-boop';
const GITHUB_REPO = 'hh-parfumerie-';
const GITHUB_BRANCH = 'main';
const CANDIDATE_PATHS = ['data/products.json', 'data/static-products.json'];

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

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
    console.error('[delete-product] Missing GITHUB_TOKEN env var.');
    return respond(500, { success: false, error: 'GITHUB_TOKEN absent des variables d\'environnement Netlify.' });
  }

  let payload;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    return respond(400, { success: false, error: 'Corps de requête JSON invalide.' });
  }

  const { id } = payload;
  if (!id) {
    return respond(400, { success: false, error: 'Champ requis manquant : id.' });
  }

  console.log('[delete-product] Suppression demandée pour id =', id);

  for (const path of CANDIDATE_PATHS) {
    try {
      const fileData = await githubRequest(`contents/${path}?ref=${GITHUB_BRANCH}`);
      const sha = fileData.sha;
      const decoded = Buffer.from(fileData.content, 'base64').toString('utf8');
      let list = [];
      try {
        list = JSON.parse(decoded || '[]');
      } catch (e) {
        list = [];
      }
      if (!Array.isArray(list)) list = [];

      const idx = list.findIndex((p) => p.id === id);
      if (idx === -1) continue; // pas dans ce fichier, on essaie le suivant

      const removed = list[idx];
      list.splice(idx, 1);

      const updatedContent = Buffer.from(JSON.stringify(list, null, 2), 'utf8').toString('base64');
      await githubRequest(`contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Suppression produit: ${removed.name || id}`,
          content: updatedContent,
          branch: GITHUB_BRANCH,
          sha,
        }),
      });

      console.log(`[delete-product] Produit "${removed.name || id}" supprimé de ${path}.`);
      return respond(200, {
        success: true,
        message: 'Produit supprimé. Le site va se mettre à jour automatiquement dans 1 à 2 minutes.',
        removedFrom: path,
      });
    } catch (e) {
      if (e.status === 404) continue; // fichier absent, on essaie le suivant
      console.error(`[delete-product] Erreur sur ${path}`, e);
      return respond(502, { success: false, error: e.message || String(e) });
    }
  }

  return respond(404, { success: false, error: `Aucun produit trouvé avec l'id "${id}".` });
};
