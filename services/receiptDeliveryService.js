const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const { gerarComprovantePng } = require("./receiptService");
const { garantirPerfilECanalPrivado } = require("./profileChannelService");
const { obterPagamento, marcarComprovanteEnviado } = require("../store");

function mascararChave(chave) {
  const texto = String(chave || "");
  if (texto.length <= 6) return texto;
  return `${texto.slice(0, 3)}***${texto.slice(-3)}`;
}

async function enviarComprovantePagamento({ client, paymentId, user = null }) {
  let pagamento = obterPagamento(paymentId);
  if (!pagamento || pagamento.status !== "concluido") return { enviado: false, motivo: "PAGAMENTO_NAO_CONCLUIDO" };
  if (pagamento.comprovanteEnviadoEm) return { enviado: false, motivo: "JA_ENVIADO" };

  const usuario = user || await client.users.fetch(pagamento.usuarioId).catch(() => null);
  if (!usuario) return { enviado: false, motivo: "USUARIO_NAO_ENCONTRADO" };

  const { canal } = await garantirPerfilECanalPrivado({ client, user: usuario });
  if (!canal?.isTextBased()) return { enviado: false, motivo: "CANAL_PRIVADO_NAO_DISPONIVEL" };

  pagamento = obterPagamento(paymentId);
  if (pagamento.comprovanteEnviadoEm) return { enviado: false, motivo: "JA_ENVIADO" };

  const png = gerarComprovantePng({ pagamento });
  const nomeArquivo = `comprovante-${pagamento.codigoHydra || pagamento.id}.png`;
  const arquivo = new AttachmentBuilder(png, { name: nomeArquivo });
  const data = new Date(pagamento.concluidoEm || Date.now()).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const embed = new EmbedBuilder()
    .setColor("#22C55E")
    .setTitle("Pagamento Pix concluído")
    .setDescription(`Seu comprovante foi gerado automaticamente pela **Hydra Systems**.`)
    .addFields(
      { name: "Valor", value: `R$ ${Number(pagamento.valor).toFixed(2).replace(".", ",")}`, inline: true },
      { name: "Recebedor", value: pagamento.nomeDestinatario || "Titular da chave", inline: true },
      { name: "Chave Pix", value: mascararChave(pagamento.chave), inline: false },
      { name: "Data e hora", value: data, inline: false },
      { name: "ID Hydra", value: pagamento.codigoHydra || pagamento.id, inline: false }
    )
    .setImage(`attachment://${nomeArquivo}`)
    .setFooter({ text: "Quem pagou: Turbofy Pagamentos • Instituição: Turbofy Pay" });

  if (pagamento.endToEndId) {
    embed.addFields({ name: "EndToEndId", value: String(pagamento.endToEndId).slice(0, 1000), inline: false });
  }

  await canal.send({ embeds: [embed], files: [arquivo] });
  marcarComprovanteEnviado(paymentId);
  return { enviado: true, canalId: canal.id };
}

module.exports = { enviarComprovantePagamento };
