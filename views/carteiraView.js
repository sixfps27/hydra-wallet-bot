const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { formatarDinheiro } = require("../utils/money");

function criarCarteiraView({ usuario, carteira, modo }) {
  const descricao = modo === "mock" ? "Ambiente de testes" : "Conta conectada";
  return {
    embeds: [new EmbedBuilder()
      .setColor("#2563EB")
      .setTitle("Hydra Wallet")
      .setDescription(`${usuario}\n\n**Saldo disponível**\n# ${formatarDinheiro(carteira.saldo)}`)
      .addFields({ name: "Em processamento", value: formatarDinheiro(carteira.reservado), inline: true })
      .setFooter({ text: descricao })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("depositar").setLabel("Depositar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("enviar_pix").setLabel("Enviar Pix").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("extrato").setLabel("Extrato").setStyle(ButtonStyle.Secondary)
    )]
  };
}
module.exports = { criarCarteiraView };
