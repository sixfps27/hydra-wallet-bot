const crypto = require("crypto");

const API_URL = (process.env.TURBOFY_API_URL || "https://api.turbofypay.com").replace(/\/$/, "");

function credenciais() {
  return {
    clientId: process.env.TURBOFY_CLIENT_ID,
    clientSecret: process.env.TURBOFY_CLIENT_SECRET
  };
}

function possuiCredenciais() {
  const { clientId, clientSecret } = credenciais();
  return Boolean(clientId && clientSecret);
}

function criarAssinatura({ method, path, timestamp, rawBody = "", clientSecret }) {
  if (!clientSecret) throw new Error("TURBOFY_CLIENT_SECRET_NAO_CONFIGURADO");
  const payload = `${timestamp}.${method.toUpperCase()}.${path}.${rawBody}`;
  return crypto.createHmac("sha256", clientSecret).update(payload, "utf8").digest("hex");
}

async function requisicaoTurbofy({ method, path, body, idempotencyKey, usarAssinatura = true }) {
  const { clientId, clientSecret } = credenciais();
  if (!clientId || !clientSecret) throw new Error("CREDENCIAIS_TURBOFY_AUSENTES");

  const metodo = method.toUpperCase();
  const timestamp = Date.now().toString();
  const rawBody = body === undefined ? "" : JSON.stringify(body);

  const headers = {
    "x-client-id": clientId,
    "x-client-secret": clientSecret
  };

  if (usarAssinatura) {
    headers["x-turbofy-timestamp"] = timestamp;
    headers["x-turbofy-signature"] = criarAssinatura({
      method: metodo,
      path,
      timestamp,
      rawBody,
      clientSecret
    });
  }

  if (rawBody) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const resposta = await fetch(`${API_URL}${path}`, {
    method: metodo,
    headers,
    body: rawBody || undefined
  });

  const texto = await resposta.text();
  let dados = {};
  try { dados = texto ? JSON.parse(texto) : {}; }
  catch { dados = { raw: texto }; }

  if (!resposta.ok) {
    const erro = new Error(dados?.error?.message || dados?.message || `Erro HTTP ${resposta.status}`);
    erro.status = resposta.status;
    erro.code = dados?.error?.code || dados?.code || "TURBOFY_API_ERROR";
    erro.details = dados;
    throw erro;
  }

  return dados;
}

async function criarCobrancaPix({ amountCents, description, externalRef, expiresAt, metadata }) {
  return requisicaoTurbofy({
    method: "POST",
    path: "/sellers/pix",
    usarAssinatura: false,
    body: {
      amountCents,
      description,
      externalRef,
      expiresAt,
      metadata: metadata || {}
    }
  });
}

async function consultarCobrancaPix(id) {
  return requisicaoTurbofy({
    method: "GET",
    path: `/sellers/pix/${encodeURIComponent(id)}`,
    usarAssinatura: false
  });
}

async function criarPayout({ pixKey, pixKeyType, amountCents, recipientName, recipientDocument, referenceId, description, metadata }) {
  const idempotencyKey = crypto.randomUUID();
  return requisicaoTurbofy({
    method: "POST",
    path: "/v1/payouts/batches",
    idempotencyKey,
    body: {
      idempotencyKey,
      description: description || "Pagamento Hydra Wallet",
      items: [{ pixKey, pixKeyType, amountCents, recipientName, recipientDocument, referenceId }],
      metadata: metadata || {}
    }
  });
}

async function consultarPayout(batchId) {
  return requisicaoTurbofy({ method: "GET", path: `/v1/payouts/batches/${encodeURIComponent(batchId)}` });
}

async function listarPayouts() {
  return requisicaoTurbofy({ method: "GET", path: "/v1/payouts/batches" });
}

module.exports = {
  possuiCredenciais,
  criarAssinatura,
  criarCobrancaPix,
  consultarCobrancaPix,
  criarPayout,
  consultarPayout,
  listarPayouts
};
