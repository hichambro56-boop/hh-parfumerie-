// netlify/functions/submit-order.js
//
// Enregistre une commande client dans data/orders.json (via l'API GitHub
// Contents), pour que le propriétaire du site puisse la voir dans
// orders.html. Sans cette fonction, le formulaire de commande ne faisait
// qu'afficher un message de remerciement côté client — les informations
// du client n'arrivaient jamais nulle part.
//
// Entrée (JSON, POST) :
//   {
//     "productName": "...", "productPrice": "...", "quantity": 1,
//     "fullname": "...", "phone": "...", "city": "..."
//   }
//
// Variables d'environnement requises :
//   GITHUB_TOKEN — Personal Access Token GitHub avec accès "repo" (write)

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
    console.error('[submit-order] Missing GITHUB_TOKEN env var.');
    return respond(500, { success: false, error: 'GITHUB_TOKEN absent des variables d\'environnement Netlify.' });
  }

  let payload;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    return respond(400, { success: false, error: 'Corps de requête JSON invalide.' });
  }

  const { productName, productPrice, quantity, fullname, phone, city } = payload;

  if (!fullname || !phone || !city) {
    return respond(400, { success: false, error: 'Champs requis manquants (fullname, phone, city).' });
  }

  const newOrder = {
    id: `o_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    productName: productName || '',
    productPrice: productPrice || '',
    quantity: quantity || 1,
    fullname,
    phone,
    city,
    createdAt: new Date().toISOString(),
  };

  console.log('[submit-order] Nouvelle commande', { fullname, phone, city, productName, quantity });

  try {
    let orders = [];
    let sha = null;
    try {
      const fileData = await githubRequest(`contents/${ORDERS_PATH}?ref=${GITHUB_BRANCH}`);
      sha = fileData.sha;
      const decoded = Buffer.from(fileData.content, 'base64').toString('utf8');
      orders = JSON.parse(decoded || '[]');
      if (!Array.isArray(orders)) orders = [];
    } catch (e) {
      if (e.status === 404) {
        console.log('[submit-order] data/orders.json n\'existe pas encore, il sera créé.');
      } else {
        throw e;
      }
    }

    orders.unshift(newOrder); // les plus récentes en premier

    const updatedContent = Buffer.from(JSON.stringify(orders, null, 2), 'utf8').toString('base64');
    await githubRequest(`contents/${ORDERS_PATH}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Nouvelle commande: ${fullname} — ${productName || 'produit'}`,
        content: updatedContent,
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

    console.log('[submit-order] Commande enregistrée avec succès.');
    return respond(200, { success: true, message: 'Commande enregistrée.', order: newOrder });
  } catch (e) {
    console.error('[submit-order] Échec', e);
    return respond(502, { success: false, error: e.message || String(e) });
  }
};
