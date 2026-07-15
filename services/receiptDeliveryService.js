const fs = require("fs");
const path = require("path");
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const { garantirPerfilECanalPrivado } = require("./profileChannelService");
const { baixarComprovantePayout } = require("./turbofyGateway");
const { obterPagamento, marcarComprovanteEnviado } = require("../store");

const RECEIPTS_DIR = path.join(__dirname, "..", "receipts");

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

async function obterPdfOficial(pagamento) {
  if (!pagamento.payoutId) throw new Error("PAGAMENTO_SEM_PAYOUT_ITEM_ID");
  garantirPastaComprovantes();

  const nomeCache = nomeSeguro(`comprovante-${pagamento.codigoHydra || pagamento.id}-${pagamento.payoutId}.pdf`, `comprovante-${pagamento.id}.pdf`);
  const caminho = path.join(RECEIPTS_DIR, nomeCache);

  if (fs.existsSync(caminho)) {
    const buffer = fs.readFileSync(caminho);
    if (buffer.subarray(0, 4).toString() === "%PDF") return { buffer, nomeArquivo: nomeCache, cache: true };
  }

  const oficial = await baixarComprovantePayout(pagamento.payoutId);
  fs.writeFileSync(caminho, oficial.buffer);
  return { buffer: oficial.buffer, nomeArquivo: nomeCache, cache: false };
}

async function enviarComprovantePagamento({ client, paymentId, user = null }) {
  let pagamento = obterPagamento(paymentId);
  if (!pagamento || pagamento.status !== "concluido") return { enviado: false, motivo: "PAGAMENTO_NAO_CONCLUIDO" };
  if (pagamento.comprovanteEnviadoEm) return { enviado: false, motivo: "JA_ENVIADO" };
  if (!pagamento.payoutId) return { enviado: false, motivo: "PAYOUT_ITEM_ID_AINDA_NAO_DISPONIVEL" };

  const usuario = user || await client.users.fetch(pagamento.usuarioId).catch(() => null);
  if (!usuario) return { enviado: false, motivo: "USUARIO_NAO_ENCONTRADO" };

  const { canal } = await garantirPerfilECanalPrivado({ client, user: usuario });
  if (!canal?.isTextBased()) return { enviado: false, motivo: "CANAL_PRIVADO_NAO_DISPONIVEL" };

  pagamento = obterPagamento(paymentId);
  if (pagamento.comprovanteEnviadoEm) return { enviado: false, motivo: "JA_ENVIADO" };

  const pdf = await obterPdfOficial(pagamento);
  const arquivo = new AttachmentBuilder(pdf.buffer, { name: pdf.nomeArquivo });
  const data = new Date(pagamento.concluidoEm || Date.now()).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

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
    embed.addFields({ name: "EndToEndId", value: String(pagamento.endToEndId).slice(0, 1000), inline: false });
  }

  await canal.send({ embeds: [embed], files: [arquivo] });
  marcarComprovanteEnviado(paymentId);
  return { enviado: true, canalId: canal.id, oficial: true, cache: pdf.cache };
}

module.exports = { enviarComprovantePagamento };
