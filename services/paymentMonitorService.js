const {
  obterPagamento, atualizarPagamento, concluirPagamento, falharPagamento,
  corrigirPagamentoConcluidoAposEstorno, definirCooldown
} = require("../store");
const { verificarEnvioPix } = require("./walletManager");
const { enviarComprovantePagamento } = require("./receiptDeliveryService");

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
const monitores = new Map();

const STATUS_OK = new Set(["paid", "completed", "concluido", "success", "succeeded", "done", "settled"]);
const STATUS_FAIL = new Set(["failed", "failure", "cancelled", "canceled", "denied", "rejected", "expired", "error"]);

// Controla somente as CONSULTAS de status. A criação do Pix continua imediata.
const MAX_CONSULTAS_SIMULTANEAS = Math.max(1, Number(process.env.PAYOUT_STATUS_CONCURRENCY || 4));
const INTERVALO_MINIMO_API_MS = Math.max(150, Number(process.env.PAYOUT_STATUS_MIN_GAP_MS || 400));
let consultasAtivas = 0;
let ultimaConsultaEm = 0;
let pausaGlobalAte = 0;
const filaConsultas = [];

function retryDepoisMs(erro) {
  const direto = Number(erro?.retryAfterMs || erro?.details?.retryAfterMs || 0);
  if (direto > 0) return direto;
  const segundos = Number(erro?.details?.retryAfter || erro?.details?.retry_after || 0);
  if (segundos > 0) return segundos * 1000;
  const texto = String(erro?.message || erro?.details?.message || "");
  const match = texto.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*seconds?/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : 0;
}

async function executarConsultaAgendada(tarefa) {
  const agora = Date.now();
  const esperaPausa = Math.max(0, pausaGlobalAte - agora);
  const esperaGap = Math.max(0, INTERVALO_MINIMO_API_MS - (agora - ultimaConsultaEm));
  if (esperaPausa || esperaGap) await esperar(Math.max(esperaPausa, esperaGap));

  consultasAtivas += 1;
  ultimaConsultaEm = Date.now();
  try {
    return await tarefa();
  } catch (erro) {
    const status = Number(erro?.status || erro?.details?.statusCode || 0);
    if (status === 429) {
      const pausa = Math.max(2000, retryDepoisMs(erro) || 2000);
      pausaGlobalAte = Math.max(pausaGlobalAte, Date.now() + pausa);
    }
    throw erro;
  } finally {
    consultasAtivas -= 1;
    drenarFila();
  }
}

function drenarFila() {
  while (consultasAtivas < MAX_CONSULTAS_SIMULTANEAS && filaConsultas.length) {
    const item = filaConsultas.shift();
    executarConsultaAgendada(item.tarefa).then(item.resolve, item.reject);
  }
}

function consultarStatusComControle(batchId) {
  return new Promise((resolve, reject) => {
    filaConsultas.push({ tarefa: () => verificarEnvioPix(batchId), resolve, reject });
    drenarFila();
  });
}

function quantidade(valor) {
  if (Array.isArray(valor)) return valor.length;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function primeiroItem(consulta = {}) {
  if (Array.isArray(consulta.items) && consulta.items.length) return consulta.items[0] || {};
  if (Array.isArray(consulta.paidItems) && consulta.paidItems.length) return consulta.paidItems[0] || {};
  if (Array.isArray(consulta.failedItems) && consulta.failedItems.length) return consulta.failedItems[0] || {};
  return {};
}

function normalizar(consulta) {
  const item = primeiroItem(consulta || {});
  const statusRaiz = String(consulta?.status || "").toLowerCase();
  const statusItem = String(item?.status || "").toLowerCase();
  const status = statusItem || statusRaiz;

  const paid = quantidade(consulta?.paidItems);
  const failed = quantidade(consulta?.failedItems);
  const comprovanteDisponivel = item?.receipt?.available === true;
  const liquidado = Boolean(item?.settledAt || item?.releasedAt || item?.tracking?.endToEndId);

  if (comprovanteDisponivel || liquidado || paid > 0 || STATUS_OK.has(statusItem) || STATUS_OK.has(statusRaiz)) {
    return { tipo: "sucesso", status: status || "paid" };
  }
  if ((failed > 0 && paid === 0) || STATUS_FAIL.has(statusItem) || STATUS_FAIL.has(statusRaiz)) {
    return { tipo: "falha", status: status || "failed" };
  }
  return { tipo: "pendente", status: status || "processing" };
}

function primeiro(...valores) {
  return valores.find(valor => valor !== undefined && valor !== null && String(valor).trim() !== "") || null;
}

function extrair(consulta = {}) {
  const item = primeiroItem(consulta);
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

async function monitorar({ client, paymentId, onLongWait, onSuccess, onFailure }) {
  if (monitores.has(paymentId)) return monitores.get(paymentId);

  const promessa = (async () => {
    const inicio = Date.now();
    let avisou = false;
    let errosSeguidos = 0;
    let passo = 0;
    const intervalosNormais = [1500, 2000, 3000, 4000, 6000, 8000, 12000, 15000, 20000, 30000];

    while (Date.now() - inicio < 20 * 60 * 1000) {
      let pagamento = obterPagamento(paymentId);
      if (!pagamento || pagamento.status === "concluido" || pagamento.status === "falhou") return pagamento;
      if (!pagamento.batchId) return pagamento;

      try {
        const consulta = await consultarStatusComControle(pagamento.batchId);
        errosSeguidos = 0;
        const resultado = normalizar(consulta);
        const dados = extrair(consulta);

        atualizarPagamento(paymentId, {
          gatewayStatus: resultado.status,
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

          // O receiptDeliveryService possui trava atômica no banco; chamadas concorrentes viram no-op.
          await enviarComprovantePagamento({ client, paymentId: final.id })
            .catch(erro => console.error("Erro ao enviar comprovante:", erro.message));
          if (onSuccess) await onSuccess(final).catch(() => {});
          return final;
        }

        if (resultado.tipo === "falha") {
          const final = falharPagamento(pagamento, resultado.status);
          definirCooldown(
            final.usuarioId,
            "pix_send",
            Math.max(60000, Number(process.env.PIX_ERROR_COOLDOWN_MS || 60000)),
            resultado.status
          );
          if (onFailure) await onFailure(final).catch(() => {});
          return final;
        }
      } catch (erro) {
        errosSeguidos += 1;
        const status = Number(erro?.status || erro?.details?.statusCode || 0);
        const espera429 = status === 429 ? Math.max(2000, retryDepoisMs(erro) || 2000) : 0;

        // Não transforma erro de consulta em falha financeira. Apenas reduz a frequência.
        if (errosSeguidos === 1 || errosSeguidos % 5 === 0) {
          console.error(`[MONITOR PIX] ${paymentId}:`, erro.code || erro.message);
        }

        const esperaErro = espera429 || (erroTemporario(erro)
          ? Math.min(60000, 5000 * Math.pow(2, Math.min(errosSeguidos - 1, 4)))
          : 15000);
        await esperar(esperaErro);
      }

      if (!avisou && Date.now() - inicio >= 30000) {
        avisou = true;
        atualizarPagamento(paymentId, { analiseAvisadaEm: Date.now() });
        if (onLongWait) await onLongWait(obterPagamento(paymentId)).catch(() => {});
      }

      await esperar(intervalosNormais[Math.min(passo++, intervalosNormais.length - 1)]);
    }

    // Permanece processando para uma reconciliação futura; nunca estorna por timeout de consulta.
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
