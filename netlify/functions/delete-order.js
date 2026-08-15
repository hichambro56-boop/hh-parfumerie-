// netlify/functions/delete-order.js
//
// Supprime une commande par son id, une fois qu'elle a été traitée
// (contactée / confirmée) — pour garder orders.html propre.
//
// Entrée (JSON, POST) : { "id": "o_..." }
// Variables d'environnement requises : GITHUB_TOKEN

const GITHUB_OWNER = 'hichambro56-boop';
const GITHUB_REPO = 'hh-parfumerie-';
const GITHUB_BRANCH = 'main';
const ORDERS_PATH = 'data/orders.json';

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

  try {
    const fileData = await githubRequest(`contents/${ORDERS_PATH}?ref=${GITHUB_BRANCH}`);
    const sha = fileData.sha;
    const decoded = Buffer.from(fileData.content, 'base64').toString('utf8');
    let orders = JSON.parse(decoded || '[]');
    if (!Array.isArray(orders)) orders = [];

    const idx = orders.findIndex((o) => o.id === id);
    if (idx === -1) {
      return respond(404, { success: false, error: `Aucune commande trouvée avec l'id "${id}".` });
    }
    orders.splice(idx, 1);

    const updatedContent = Buffer.from(JSON.stringify(orders, null, 2), 'utf8').toString('base64');
    await githubRequest(`contents/${ORDERS_PATH}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Suppression commande: ${id}`,
        content: updatedContent,
        branch: GITHUB_BRANCH,
        sha,
      }),
    });

    return respond(200, { success: true, message: 'Commande supprimée.' });
  } catch (e) {
    console.error('[delete-order] Échec', e);
    return respond(502, { success: false, error: e.message || String(e) });
  }
};
