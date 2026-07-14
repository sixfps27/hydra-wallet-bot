const {
  enviarPix,
  consultarPagamento,
  estaNoModoTeste
} = require("./paymentGateway");

/*
 * Descobre automaticamente o tipo da chave Pix.
 */
function descobrirTipoChavePix(chave) {
  const chaveLimpa = chave.trim();

  if (chaveLimpa.includes("@")) {
    return "EMAIL";
  }

  const somenteNumeros = chaveLimpa.replace(/\D/g, "");

  if (somenteNumeros.length === 11) {
    return "CPF";
  }

  if (somenteNumeros.length === 14) {
    return "CNPJ";
  }

  if (
    chaveLimpa.startsWith("+") ||
    somenteNumeros.length === 10 ||
    somenteNumeros.length === 11
  ) {
    return "PHONE";
  }

  return "EVP";
}

/*
 * Converte reais para centavos.
 *
 * Exemplo:
 * R$ 6,00 vira 600.
 */
function converterParaCentavos(valor) {
  return Math.round(Number(valor) * 100);
}

/*
 * Envia o pagamento para o gateway.
 *
 * Hoje ele usa o modo mock.
 * Amanhã poderá usar a Turbofy.
 */
async function processarEnvioPix({
  usuarioId,
  chavePix,
  valor,
  nomeDestinatario = "Destinatário",
  documentoDestinatario = "00000000000",
  referencia
}) {
  if (!usuarioId) {
    throw new Error("USUARIO_NAO_INFORMADO");
  }

  if (!chavePix || chavePix.trim().length < 3) {
    throw new Error("CHAVE_PIX_INVALIDA");
  }

  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error("VALOR_INVALIDO");
  }

  const tipoChave = descobrirTipoChavePix(chavePix);
  const valorCentavos = converterParaCentavos(valor);

  const resultado = await enviarPix({
    pixKey: chavePix.trim(),
    pixKeyType: tipoChave,
    amountCents: valorCentavos,
    recipientName: nomeDestinatario,
    recipientDocument: documentoDestinatario,
    referenceId: referencia,
    discordUserId: usuarioId
  });

  return {
    ...resultado,
    pixKeyType: tipoChave,
    amountCents: valorCentavos,
    modoTeste: estaNoModoTeste()
  };
}

/*
 * Consulta se o pagamento foi concluído.
 */
async function verificarEnvioPix(batchId) {
  if (!batchId) {
    throw new Error("BATCH_ID_NAO_INFORMADO");
  }

  return consultarPagamento(batchId);
}

module.exports = {
  descobrirTipoChavePix,
  converterParaCentavos,
  processarEnvioPix,
  verificarEnvioPix
};