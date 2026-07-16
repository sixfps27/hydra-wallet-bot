const {
  obterPagamento,
  atualizarPagamento,
  concluirPagamento,
  falharPagamento,
  corrigirPagamentoConcluidoAposEstorno,
  definirCooldown
} = require("../store");
const { verificarEnvioPix } = require("./walletManager");
const { enviarComprovantePagamento } = require("./receiptDeliveryService");

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
const monitores = new Map();

const STATUS_OK = new Set(["paid", "completed", "concluido", "success", "succeeded", "done", "settled", "released"]);
const STATUS_FAIL = new Set(["failed", "failure", "cancelled", "canceled", "denied", "rejected", "expired", "error"]);

// Consultas de status são controladas aqui. A criação do PIX continua em outra fila e não é atrasada.
const MAX_CONSULTAS_SIMULTANEAS = Math.max(1, Number(process.env.PAYOUT_STATUS_CONCURRENCY || 3));
const INTERVALO_MINIMO_API_MS = Math.max(350, Number(process.env.PAYOUT_STATUS_MIN_GAP_MS || 650));
const filaConsultas = [];
let consultasAtivas = 0;
let ultimaConsultaEm = 0;
let pausaGlobalAte = 0;
let falhasGlobaisRecentes = [];

function retryDepoisMs(erro) {
  const direto = Number(erro?.retryAfterMs || erro?.details?.retryAfterMs || 0);
  if (direto > 0) return direto;
  const segundos = Number(erro?.details?.retryAfter || erro?.details?.retry_after || 0);
  if (segundos > 0) return segundos * 1000;
  const texto = String(erro?.message || erro?.details?.message || "");
  const match = texto.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*seconds?/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : 0;
}

function registrarFalhaGlobal(erro) {
  const agora = Date.now();
  falhasGlobaisRecentes = falhasGlobaisRecentes.filter(ts => agora - ts < 30000);
  falhasGlobaisRecentes.push(agora);

  const status = Number(erro?.status || erro?.details?.statusCode || 0);
  if (status === 429) {
    pausaGlobalAte = Math.max(pausaGlobalAte, agora + Math.max(3000, retryDepoisMs(erro) || 3000));
  } else if (falhasGlobaisRecentes.length >= 5) {
    // Circuit breaker curto: evita tempestade de consultas quando a API fica instável.
    pausaGlobalAte = Math.max(pausaGlobalAte, agora + 15000);
  }
}

async function executarConsultaAgendada(item) {
  const agora = Date.now();
  const esperaPausa = Math.max(0, pausaGlobalAte - agora);
  const esperaGap = Math.max(0, INTERVALO_MINIMO_API_MS - (agora - ultimaConsultaEm));
  if (esperaPausa || esperaGap) await esperar(Math.max(esperaPausa, esperaGap));

  consultasAtivas += 1;
  ultimaConsultaEm = Date.now();
  try {
    return await item.tarefa();
  } catch (erro) {
    registrarFalhaGlobal(erro);
    throw erro;
  } finally {
    consultasAtivas -= 1;
    drenarFila();
  }
}

function drenarFila() {
  while (consultasAtivas < MAX_CONSULTAS_SIMULTANEAS && filaConsultas.length) {
    filaConsultas.sort((a, b) => a.prioridade - b.prioridade || a.criadoEm - b.criadoEm);
    const item = filaConsultas.shift();
    executarConsultaAgendada(item).then(item.resolve, item.reject);
  }
}

function consultarStatusComControle(batchId, prioridade = 5) {
  return new Promise((resolve, reject) => {
    filaConsultas.push({
      tarefa: () => verificarEnvioPix(batchId),
      prioridade,
      criadoEm: Date.now(),
      resolve,
      reject
    });
    drenarFila();
  });
}

function valorTexto(valor) {
  return valor === undefined || valor === null ? null : String(valor).trim();
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
  ].map(valorTexto).filter(Boolean);
}

function selecionarItem(consulta = {}, pagamento = {}) {
  const grupos = [consulta.items, consulta.paidItems, consulta.failedItems].filter(Array.isArray);
  const itens = grupos.flat().filter(Boolean);
  if (!itens.length) return null;

  const procurados = [
    pagamento.id,
    pagamento.externalRef,
    pagamento.payoutId,
    pagamento.endToEndId,
    pagamento.idempotencyKey
  ].map(valorTexto).filter(Boolean);

  const encontrado = itens.find(item => {
    const refs = referenciasDoItem(item);
    return procurados.some(id => refs.includes(id));
  });

  // Só usa fallback quando o lote possui um único item. Em lote com vários itens,
  // escolher items[0] pode confirmar o pagamento errado e deixar o correto em análise.
  return encontrado || (itens.length === 1 ? itens[0] : null);
}

function quantidade(valor) {
  if (Array.isArray(valor)) return valor.length;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function normalizar(consulta = {}, pagamento = {}) {
  const item = selecionarItem(consulta, pagamento);
  const statusRaiz = String(consulta?.status || "").toLowerCase();
  const statusItem = String(item?.status || "").toLowerCase();
  const status = statusItem || statusRaiz || "processing";

  const comprovanteDisponivel = item?.receipt?.available === true;
  const liquidado = Boolean(item?.settledAt || item?.releasedAt || item?.tracking?.endToEndId);

  if (item && (comprovanteDisponivel || liquidado || STATUS_OK.has(statusItem))) {
    return { tipo: "sucesso", status, item };
  }
  if (item && STATUS_FAIL.has(statusItem)) {
    return { tipo: "falha", status, item };
  }

  // Totais do lote só são confiáveis para este pagamento quando há um único item.
  const totalItens = quantidade(consulta?.totalItems) || (Array.isArray(consulta?.items) ? consulta.items.length : 0);
  if (totalItens <= 1) {
    if (quantidade(consulta?.paidItems) > 0 || STATUS_OK.has(statusRaiz)) return { tipo: "sucesso", status, item };
    if (quantidade(consulta?.failedItems) > 0 || STATUS_FAIL.has(statusRaiz)) return { tipo: "falha", status, item };
  }

  return { tipo: "pendente", status, item };
}

function primeiro(...valores) {
  return valores.find(valor => valor !== undefined && valor !== null && String(valor).trim() !== "") || null;
}

function extrair(item = {}, consulta = {}) {
  return {
    nomeDestinatario: primeiro(item.recipientName, item.beneficiary?.name, consulta.recipientName),
    documentoDestinatario: primeiro(item.recipientDocument, item.beneficiary?.document, consulta.recipientDocument),
    payoutId: primeiro(item.id, item.payoutItemId, consulta.payoutId),
    endToEndId: primeiro(item.tracking?.endToEndId, item.endToEndId, consulta.endToEndId),
    providerTransactionId: primeiro(item.providerTransactionId, item.transactionId, consulta.providerTransactionId),
    providerChargeId: primeiro(item.providerChargeId, item.chargeId, consulta.providerChargeId),
    pixTxid: primeiro(item.pixTxid, item.txid, consulta.pixTxid),
    externalRef: primeiro(item.tracking?.referenceId, item.referenceId, item.externalRef, consulta.externalRef)
  };
}

function erroTemporario(erro) {
  const status = Number(erro?.status || erro?.details?.statusCode || 0);
  return status === 429 || status >= 500 || status === 0 || erro?.code === "TURBOFY_API_ERROR";
}

async function monitorar({ client, paymentId, prioridade = "alta", onLongWait, onSuccess, onFailure }) {
  if (monitores.has(paymentId)) return monitores.get(paymentId);

  const promessa = (async () => {
    const inicio = Date.now();
    let avisou = false;
    let errosSeguidos = 0;
    let passo = 0;
    const prioridadeFila = prioridade === "baixa" ? 20 : 0;
    const intervalosNormais = [1200, 1800, 2500, 3500, 5000, 7000, 10000, 15000, 20000, 30000];

    while (Date.now() - inicio < 20 * 60 * 1000) {
      let pagamento = obterPagamento(paymentId);
      if (!pagamento || pagamento.status === "concluido" || pagamento.status === "falhou") return pagamento;
      if (!pagamento.batchId) return pagamento;

      const agora = Date.now();
      if (pagamento.retryAfter && Number(pagamento.retryAfter) > agora) {
        await esperar(Math.min(30000, Number(pagamento.retryAfter) - agora));
        continue;
      }

      try {
        const consulta = await consultarStatusComControle(pagamento.batchId, prioridadeFila);
        errosSeguidos = 0;
        const resultado = normalizar(consulta, pagamento);
        const dados = extrair(resultado.item || {}, consulta);

        atualizarPagamento(paymentId, {
          gatewayStatus: resultado.status,
          retryCount: 0,
          retryAfter: null,
          nomeDestinatario: dados.nomeDestinatario || pagamento.nomeDestinatario,
          documentoDestinatario: dados.documentoDestinatario || pagamento.documentoDestinatario,
          payoutId: dados.payoutId || pagamento.payoutId,
          endToEndId: dados.endToEndId || pagamento.endToEndId,
          providerTransactionId: dados.providerTransactionId || pagamento.providerTransactionId,
          providerChargeId: dados.providerChargeId || pagamento.providerChargeId,
          pixTxid: dados.pixTxid || pagamento.pixTxid,
          externalRef: dados.externalRef || pagamento.externalRef
        });
        pagamento = obterPagamento(paymentId);

        if (resultado.tipo === "sucesso") {
          const final = pagamento.status === "falhou"
            ? corrigirPagamentoConcluidoAposEstorno(pagamento, pagamento.batchId, resultado.status)
            : concluirPagamento(pagamento, pagamento.batchId, resultado.status);

          await enviarComprovantePagamento({ client, paymentId: final.id })
            .catch(erro => console.error("Erro ao enviar comprovante:", erro.message));
          if (onSuccess) await onSuccess(final).catch(() => {});
          return final;
        }

        if (resultado.tipo === "falha") {
          const final = falharPagamento(pagamento, resultado.status);
          definirCooldown(final.usuarioId, "pix_send", Math.max(60000, Number(process.env.PIX_ERROR_COOLDOWN_MS || 60000)), resultado.status);
          if (onFailure) await onFailure(final).catch(() => {});
          return final;
        }
      } catch (erro) {
        errosSeguidos += 1;
        const status = Number(erro?.status || erro?.details?.statusCode || 0);
        const espera429 = status === 429 ? Math.max(3000, retryDepoisMs(erro) || 3000) : 0;
        const esperaErro = espera429 || (erroTemporario(erro)
          ? Math.min(60000, 5000 * Math.pow(2, Math.min(errosSeguidos - 1, 4)))
          : 15000);

        atualizarPagamento(paymentId, {
          retryCount: errosSeguidos,
          retryAfter: Date.now() + esperaErro
        });

        if (errosSeguidos === 1 || errosSeguidos % 5 === 0) {
          console.error(`[MONITOR PIX] ${paymentId}:`, erro.code || erro.message, `nova consulta em ${Math.ceil(esperaErro / 1000)}s`);
        }
        await esperar(esperaErro);
      }

      if (!avisou && Date.now() - inicio >= 30000) {
        avisou = true;
        atualizarPagamento(paymentId, { analiseAvisadaEm: Date.now() });
        if (onLongWait) await onLongWait(obterPagamento(paymentId)).catch(() => {});
      }

      await esperar(intervalosNormais[Math.min(passo++, intervalosNormais.length - 1)]);
    }

    return obterPagamento(paymentId);
  })().finally(() => monitores.delete(paymentId));

  monitores.set(paymentId, promessa);
  return promessa;
}

function estaMonitorando(paymentId) {
  return monitores.has(paymentId);
}

function quantidadeMonitores() {
  return monitores.size;
}

module.exports = { monitorar, estaMonitorando, quantidadeMonitores };
