const fs = require("fs");
const path = require("path");
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const { garantirPerfilECanalPrivado } = require("./profileChannelService");
const { consultarPayout, baixarPdfPorEndpoint, baixarComprovanteTransacao } = require("./turbofyGateway");
const { obterPagamento, atualizarPagamento, marcarComprovanteEnviado } = require("../store");

const RECEIPTS_DIR = path.join(__dirname, "..", "receipts");
const consultasEmAndamento = new Map();

function mascararChave(chave) {
  const texto = String(chave || "");
  if (texto.length <= 6) return texto;
  return `${texto.slice(0, 3)}***${texto.slice(-3)}`;
}

function garantirPastaComprovantes() {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
}

function nomeSeguro(nome, fallback) {
  return String(nome || fallback).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function primeiro(...valores) {
  return valores.find(valor => valor !== undefined && valor !== null && String(valor).trim() !== "") || null;
}

function selecionarItemDoPagamento(resposta, pagamento) {
  const itens = Array.isArray(resposta?.items) ? resposta.items : [];
  if (!itens.length) return null;

  return itens.find(item => {
    const referencias = [
      item.referenceId,
      item.tracking?.referenceId,
      item.id,
      item.tracking?.idempotencyKey
    ].filter(Boolean).map(String);

    return referencias.includes(String(pagamento.id)) ||
      (pagamento.payoutId && String(item.id) === String(pagamento.payoutId));
  }) || itens[0];
}

function dadosDoItem(item = {}) {
  return {
    payoutId: primeiro(item.id),
    endToEndId: primeiro(item.tracking?.endToEndId, item.endToEndId),
    externalRef: primeiro(item.tracking?.referenceId, item.referenceId),
    nomeDestinatario: primeiro(item.recipientName, item.beneficiary?.name, item.receipt?.details?.recipient?.name),
    documentoDestinatario: primeiro(item.beneficiary?.document, item.receipt?.details?.recipient?.document),
    receiptAvailable: item.receipt?.available === true,
    receiptEndpoint: primeiro(item.receipt?.endpoint)
  };
}

async function obterItemComprovante(pagamento) {
  if (!pagamento?.batchId) return { pagamento, item: null, dados: {} };

  const chave = String(pagamento.batchId);
  let promessa = consultasEmAndamento.get(chave);
  if (!promessa) {
    promessa = consultarPayout(pagamento.batchId).finally(() => consultasEmAndamento.delete(chave));
    consultasEmAndamento.set(chave, promessa);
  }

  const resposta = await promessa;
  const item = selecionarItemDoPagamento(resposta, pagamento);
  if (!item) return { pagamento, item: null, dados: {} };

  const dados = dadosDoItem(item);
  atualizarPagamento(pagamento.id, {
    payoutId: dados.payoutId || pagamento.payoutId,
    endToEndId: dados.endToEndId || pagamento.endToEndId,
    externalRef: dados.externalRef || pagamento.externalRef,
    nomeDestinatario: dados.nomeDestinatario || pagamento.nomeDestinatario,
    documentoDestinatario: dados.documentoDestinatario || pagamento.documentoDestinatario
  });

  return { pagamento: obterPagamento(pagamento.id), item, dados };
}

async function obterPdfOficial(pagamento) {
  garantirPastaComprovantes();

  const { pagamento: atualizado, dados } = await obterItemComprovante(pagamento);
  pagamento = atualizado;

  const identificadorCache = dados.receiptEndpoint || pagamento.endToEndId || pagamento.payoutId || pagamento.id;
  const nomeCache = nomeSeguro(
    `comprovante-${pagamento.codigoHydra || pagamento.id}-${identificadorCache}.pdf`,
    `comprovante-${pagamento.id}.pdf`
  );
  const caminho = path.join(RECEIPTS_DIR, nomeCache);

  if (fs.existsSync(caminho)) {
    const buffer = fs.readFileSync(caminho);
    if (buffer.subarray(0, 4).toString() === "%PDF") {
      return { buffer, nomeArquivo: nomeCache, cache: true, pagamento };
    }
  }

  let oficial;
  if (dados.receiptAvailable && dados.receiptEndpoint) {
    oficial = await baixarPdfPorEndpoint(dados.receiptEndpoint);
  } else if (pagamento.endToEndId) {
    oficial = await baixarComprovanteTransacao(pagamento.endToEndId);
  } else {
    const erro = new Error("COMPROVANTE_AINDA_NAO_DISPONIVEL");
    erro.code = "RECEIPT_UNAVAILABLE";
    erro.status = 409;
    throw erro;
  }

  fs.writeFileSync(caminho, oficial.buffer);
  return { buffer: oficial.buffer, nomeArquivo: nomeCache, cache: false, pagamento };
}

async function enviarComprovantePagamento({ client, paymentId, user = null }) {
  let pagamento = obterPagamento(paymentId);
  if (!pagamento || pagamento.status !== "concluido") {
    return { enviado: false, motivo: "PAGAMENTO_NAO_CONCLUIDO" };
  }
  if (pagamento.comprovanteEnviadoEm) return { enviado: false, motivo: "JA_ENVIADO" };

  const usuario = user || await client.users.fetch(pagamento.usuarioId).catch(() => null);
  if (!usuario) return { enviado: false, motivo: "USUARIO_NAO_ENCONTRADO" };

  const { canal } = await garantirPerfilECanalPrivado({ client, user: usuario });
  if (!canal?.isTextBased()) return { enviado: false, motivo: "CANAL_PRIVADO_NAO_DISPONIVEL" };

  pagamento = obterPagamento(paymentId);
  if (pagamento.comprovanteEnviadoEm) return { enviado: false, motivo: "JA_ENVIADO" };

  const pdf = await obterPdfOficial(pagamento);
  pagamento = pdf.pagamento || obterPagamento(paymentId);

  const arquivo = new AttachmentBuilder(pdf.buffer, { name: pdf.nomeArquivo });
  const data = new Date(pagamento.concluidoEm || Date.now()).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo"
  });

  const embed = new EmbedBuilder()
    .setColor("#22C55E")
    .setTitle("Pagamento Pix concluído")
    .setDescription("O **comprovante oficial da Turbofy** está anexado abaixo.")
    .addFields(
      { name: "Valor", value: `R$ ${Number(pagamento.valor).toFixed(2).replace(".", ",")}`, inline: true },
      { name: "Recebedor", value: pagamento.nomeDestinatario || "Titular da chave", inline: true },
      { name: "Chave Pix", value: mascararChave(pagamento.chave), inline: false },
      { name: "Data e hora", value: data, inline: false },
      { name: "ID Hydra", value: pagamento.codigoHydra || pagamento.id, inline: false }
    )
    .setFooter({ text: "Hydra Systems • Comprovante oficial emitido pela Turbofy" });

  if (pagamento.endToEndId) {
    embed.addFields({
      name: "EndToEndId",
      value: String(pagamento.endToEndId).slice(0, 1000),
      inline: false
    });
  }

  await canal.send({ embeds: [embed], files: [arquivo] });
  marcarComprovanteEnviado(paymentId);
  return { enviado: true, canalId: canal.id, oficial: true, cache: pdf.cache };
}

module.exports = { enviarComprovantePagamento };
