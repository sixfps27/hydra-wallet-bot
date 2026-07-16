const {
  obterPagamento, atualizarPagamento, concluirPagamento, falharPagamento,
  corrigirPagamentoConcluidoAposEstorno, definirCooldown
} = require("../store");
const { verificarEnvioPix } = require("./walletManager");
const { enviarComprovantePagamento } = require("./receiptDeliveryService");

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
const monitores = new Map();
const STATUS_OK = new Set(["paid","completed","concluido","success","succeeded","done"]);
const STATUS_FAIL = new Set(["failed","failure","cancelled","canceled","denied","rejected","expired","error"]);

function normalizar(consulta) {
  const status = String(consulta?.status || "").toLowerCase();
  const paid = Number(consulta?.paidItems || 0);
  const failed = Number(consulta?.failedItems || 0);
  if (paid > 0 || STATUS_OK.has(status)) return { tipo:"sucesso", status:status || "paid" };
  if ((failed > 0 && paid === 0) || STATUS_FAIL.has(status)) return { tipo:"falha", status:status || "failed" };
  return { tipo:"pendente", status:status || "processing" };
}

function primeiro(...v) { return v.find(x => x !== undefined && x !== null && String(x).trim() !== "") || null; }
function extrair(consulta={}) {
  const item = Array.isArray(consulta.items) ? consulta.items[0] || {} : {};
  return {
    nomeDestinatario: primeiro(item.recipientName,item.beneficiary?.name,consulta.recipientName),
    documentoDestinatario: primeiro(item.recipientDocument,item.beneficiary?.document,consulta.recipientDocument),
    payoutId: primeiro(item.id,item.payoutItemId,consulta.payoutId),
    endToEndId: primeiro(item.tracking?.endToEndId,item.endToEndId,consulta.endToEndId),
    providerTransactionId: primeiro(item.providerTransactionId,item.transactionId,consulta.providerTransactionId),
    providerChargeId: primeiro(item.providerChargeId,item.chargeId,consulta.providerChargeId),
    pixTxid: primeiro(item.pixTxid,item.txid,consulta.pixTxid),
    externalRef: primeiro(item.tracking?.referenceId,item.referenceId,item.externalRef,consulta.externalRef)
  };
}

async function monitorar({ client, paymentId, onLongWait, onSuccess, onFailure }) {
  if (monitores.has(paymentId)) return monitores.get(paymentId);
  const promessa = (async () => {
    const inicio = Date.now();
    let avisou = false;
    const intervalos = [2000,3000,5000,8000,12000,15000,15000,30000];
    let passo = 0;

    while (Date.now() - inicio < 15 * 60 * 1000) {
      let pagamento = obterPagamento(paymentId);
      if (!pagamento || pagamento.status === "concluido" || pagamento.status === "falhou") return pagamento;
      if (!pagamento.batchId) return pagamento;

      try {
        const consulta = await verificarEnvioPix(pagamento.batchId);
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
          await enviarComprovantePagamento({ client, paymentId: final.id }).catch(e => console.error("Erro ao enviar comprovante:", e.message));
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
        if (Number(erro.status) === 429) {
          await esperar(Math.max(2000, Number(erro.retryAfterMs || 2000)));
          continue;
        }
        console.error(`[MONITOR PIX] ${paymentId}:`, erro.code || erro.message);
      }

      if (!avisou && Date.now() - inicio >= 30000) {
        avisou = true;
        atualizarPagamento(paymentId, { analiseAvisadaEm: Date.now() });
        if (onLongWait) await onLongWait(obterPagamento(paymentId)).catch(() => {});
      }
      await esperar(intervalos[Math.min(passo++, intervalos.length - 1)]);
    }
    return obterPagamento(paymentId);
  })().finally(() => monitores.delete(paymentId));
  monitores.set(paymentId, promessa);
  return promessa;
}

function estaMonitorando(paymentId) { return monitores.has(paymentId); }
module.exports = { monitorar, estaMonitorando };
