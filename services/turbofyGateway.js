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
    const retryAfter = resposta.headers.get("retry-after");
    if (retryAfter) erro.retryAfterMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    throw erro;
  }

  return dados;
}

async function criarCobrancaPix({ amountCents, description, externalRef, expiresAt, metadata }) {
  return requisicaoTurbofy({
    method: "POST",
    path: "/sellers/pix",
    usarAssinatura: false,
    body: { amountCents, description, externalRef, expiresAt, metadata: metadata || {} }
  });
}

async function consultarCobrancaPix(id) {
  return requisicaoTurbofy({
    method: "GET",
    path: `/sellers/pix/${encodeURIComponent(id)}`,
    usarAssinatura: false
  });
}

async function criarPayout({ pixKey, pixKeyType, amountCents, recipientName, recipientDocument, referenceId, description, metadata, idempotencyKey }) {
  idempotencyKey = idempotencyKey || crypto.randomUUID();
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
  return requisicaoTurbofy({
    method: "GET",
    path: `/v1/payouts/batches/${encodeURIComponent(batchId)}`
  });
}

async function baixarPdfPorEndpoint(endpoint) {
  if (!endpoint) throw new Error("ENDPOINT_COMPROVANTE_NAO_INFORMADO");

  let path = String(endpoint).trim();
  if (path.startsWith(API_URL)) path = path.slice(API_URL.length);
  if (!path.startsWith("/")) throw new Error("ENDPOINT_COMPROVANTE_INVALIDO");

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
    const texto = await resposta.text().catch(() => "");
    let dados = {};
    try { dados = texto ? JSON.parse(texto) : {}; }
    catch { dados = { raw: texto }; }

    const erro = new Error(
      dados?.error?.message || dados?.message || `ERRO_COMPROVANTE_TURBOFY_HTTP_${resposta.status}`
    );
    erro.status = resposta.status;
    erro.code = dados?.error?.code || dados?.code || `HTTP_${resposta.status}`;
    erro.details = dados;
    throw erro;
  }

  const contentType = resposta.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/pdf")) {
    throw new Error("RESPOSTA_COMPROVANTE_NAO_E_PDF");
  }

  const buffer = Buffer.from(await resposta.arrayBuffer());
  if (buffer.subarray(0, 4).toString() !== "%PDF") {
    throw new Error("PDF_COMPROVANTE_INVALIDO");
  }

  const disposition = resposta.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
  const fallbackId = path.split("/").filter(Boolean).slice(-2, -1)[0] || "turbofy";
  const nomeArquivo = match
    ? decodeURIComponent(match[1].replace(/"/g, "").trim())
    : `comprovante-${fallbackId}.pdf`;

  return { buffer, nomeArquivo, contentType, endpoint: path };
}

async function baixarComprovanteTransacao(transactionId) {
  if (!transactionId) throw new Error("TRANSACTION_ID_NAO_INFORMADO");
  return baixarPdfPorEndpoint(`/v1/receipts/transactions/${encodeURIComponent(String(transactionId))}`);
}

async function listarPayouts({ limit = 50, offset = 0 } = {}) {
  const limite = Math.max(1, Math.min(100, Number(limit) || 50));
  const deslocamento = Math.max(0, Number(offset) || 0);
  return requisicaoTurbofy({
    method: "GET",
    path: `/v1/payouts/batches?limit=${limite}&offset=${deslocamento}`
  });
}

function referenciasDoItem(item = {}) {
  return [
    item.id,
    item.payoutItemId,
    item.referenceId,
    item.externalRef,
    item.externalReference,
    item.tracking?.referenceId,
    item.tracking?.idempotencyKey,
    item.tracking?.endToEndId,
    item.endToEndId
  ].filter(Boolean).map(valor => String(valor).trim());
}

async function localizarPayoutPorReferencia(referenceId, { paginas = 2, limit = 50 } = {}) {
  const procurado = String(referenceId || "").trim();
  if (!procurado) throw new Error("REFERENCE_ID_NAO_INFORMADO");

  const maxPaginas = Math.max(1, Math.min(5, Number(paginas) || 2));
  const limite = Math.max(1, Math.min(100, Number(limit) || 50));

  for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
    const resposta = await listarPayouts({ limit: limite, offset: pagina * limite });
    const lotes = Array.isArray(resposta?.items) ? resposta.items : [];

    for (const lote of lotes) {
      const grupos = [lote.items, lote.paidItems, lote.failedItems].filter(Array.isArray);
      const itens = grupos.flat().filter(Boolean);
      const item = itens.find(candidato => referenciasDoItem(candidato).includes(procurado));

      if (item) {
        return {
          batchId: lote.id,
          status: lote.status || item.status || "processing",
          lote,
          item
        };
      }
    }

    if (lotes.length < limite) break;
  }

  return null;
}

module.exports = {
  possuiCredenciais,
  criarAssinatura,
  criarCobrancaPix,
  consultarCobrancaPix,
  criarPayout,
  consultarPayout,
  listarPayouts,
  localizarPayoutPorReferencia,
  baixarPdfPorEndpoint,
  baixarComprovanteTransacao
};
