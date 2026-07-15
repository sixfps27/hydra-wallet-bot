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


async function baixarComprovanteTransacao(identificador) {
  if (!identificador) throw new Error("IDENTIFICADOR_COMPROVANTE_NAO_INFORMADO");

  const id = encodeURIComponent(String(identificador).trim());
  const path = `/v1/receipts/transactions/${id}`;
  const { clientId, clientSecret } = credenciais();
  if (!clientId || !clientSecret) throw new Error("CREDENCIAIS_TURBOFY_AUSENTES");

  const timestamp = Date.now().toString();
  const headers = {
    Accept: "application/pdf",
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
    "x-turbofy-timestamp": timestamp,
    "x-turbofy-signature": criarAssinatura({
      method: "GET",
      path,
      timestamp,
      rawBody: "",
      clientSecret
    })
  };

  const resposta = await fetch(`${API_URL}${path}`, { method: "GET", headers });

  if (!resposta.ok) {
    const contentType = resposta.headers.get("content-type") || "";
    let detalhes = "";
    let code = "TURBOFY_RECEIPT_ERROR";

    try {
      if (contentType.includes("application/json")) {
        const json = await resposta.json();
        code = json?.error?.code || json?.code || code;
        detalhes = JSON.stringify(json).slice(0, 1500);
      } else {
        detalhes = (await resposta.text()).slice(0, 1500);
      }
    } catch {}

    const erro = new Error(`ERRO_COMPROVANTE_TURBOFY_HTTP_${resposta.status}`);
    erro.status = resposta.status;
    erro.code = code;
    erro.details = detalhes;
    throw erro;
  }

  const contentType = resposta.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/pdf")) {
    const texto = await resposta.text().catch(() => "");
    const erro = new Error("RESPOSTA_COMPROVANTE_NAO_E_PDF");
    erro.details = texto.slice(0, 1000);
    throw erro;
  }

  const arrayBuffer = await resposta.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length < 100 || buffer.subarray(0, 4).toString() !== "%PDF") {
    throw new Error("PDF_COMPROVANTE_INVALIDO");
  }

  const disposition = resposta.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
  const nomeArquivo = match
    ? decodeURIComponent(match[1].replace(/\"/g, "").trim())
    : `comprovante-transacao-${id}.pdf`;

  return { buffer, nomeArquivo, contentType, identificador: String(identificador) };
}

// Mantido como alias para não quebrar chamadas antigas.
async function baixarComprovantePayout(identificador) {
  return baixarComprovanteTransacao(identificador);
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
  listarPayouts,
  baixarComprovantePayout,
  baixarComprovanteTransacao
};
