const crypto = require("crypto");

const {
  possuiCredenciais,
  criarPayout,
  consultarPayout
} = require("./turbofyGateway");
const { enfileirar } = require("./payoutSecurityService");

function obterModoPagamento() {
  return process.env.PAYMENT_MODE || "mock";
}

function estaNoModoTeste() {
  return obterModoPagamento() === "mock";
}

async function enviarPix({
  pixKey,
  pixKeyType,
  amountCents,
  recipientName,
  recipientDocument,
  referenceId,
  discordUserId,
  idempotencyKey
}) {
  if (estaNoModoTeste()) {
    const batchId =
      "mock_" +
      crypto.randomUUID().replaceAll("-", "").slice(0, 12);

    return {
      batchId,
      status: "processing",
      totalAmountCents: amountCents,
      totalFeeCents: 0,
      totalFundingCents: amountCents,
      itemsCount: 1,
      mock: true
    };
  }

  if (!possuiCredenciais()) {
    throw new Error("CREDENCIAIS_TURBOFY_AUSENTES");
  }

  return criarPayout({
    pixKey,
    pixKeyType,
    amountCents,
    recipientName,
    recipientDocument,
    referenceId,
    description: "Pagamento Hydra Systems",
    metadata: {
      discordUserId
    },
    idempotencyKey
  });
}

async function consultarPagamento(batchId) {
  if (batchId.startsWith("mock_")) {
    return {
      id: batchId,
      status: "paid",
      totalAmountCents: 0,
      totalFeeCents: 0,
      totalItems: 1,
      paidItems: 1,
      failedItems: 0,
      mock: true
    };
  }

  // Consultas de status são controladas pelo paymentMonitorService, com prioridade e circuit breaker.
  return consultarPayout(batchId);
}

module.exports = {
  obterModoPagamento,
  estaNoModoTeste,
  enviarPix,
  consultarPagamento
};