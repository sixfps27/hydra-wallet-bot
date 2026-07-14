const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { formatarDinheiro } = require("../utils/money");

function criarConfirmacao({ chave, valor, saldoRestante, pagamentoId }) {
  const embed = new EmbedBuilder()
    .setColor("#2563EB")
    .setTitle("Confirmar pagamento")
    .setDescription([
      `**${formatarDinheiro(valor)}**`,
      "",
      "Destino",
      `\`${chave}\``,
      "",
      "Saldo após o envio",
      `**${formatarDinheiro(saldoRestante)}**`
    ].join("\n"))
    .setFooter({ text: "Hydra Wallet" });

  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cancelar_pix:${pagamentoId}`).setLabel("Não").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`confirmar_pix:${pagamentoId}`).setLabel("Sim").setStyle(ButtonStyle.Success)
  )];
  return { embeds: [embed], components };
}
module.exports = { criarConfirmacao };
