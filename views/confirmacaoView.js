const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { formatarDinheiro } = require("../utils/money");
const { COLORS, FOOTER } = require("./theme");

function criarConfirmacao({ chave, valor, saldoRestante, pagamentoId }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.accent)
    .setAuthor({ name: "HYDRA SYSTEMS" })
    .setTitle("Confirmar transferência Pix")
    .setDescription("Confira os dados abaixo antes de autorizar o pagamento.")
    .addFields(
      { name: "💸 Valor", value: `# ${formatarDinheiro(valor)}`, inline: false },
      { name: "🔑 Chave Pix", value: `\`${chave}\``, inline: false },
      { name: "💳 Saldo após o envio", value: `**${formatarDinheiro(saldoRestante)}**`, inline: false }
    )
    .setFooter({ text: `${FOOTER} • Confirme somente se os dados estiverem corretos` })
    .setTimestamp();

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cancelar_pix:${pagamentoId}`).setLabel("Cancelar").setEmoji("✖️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`confirmar_pix:${pagamentoId}`).setLabel("Confirmar Pix").setEmoji("✅").setStyle(ButtonStyle.Success)
    )
  ];

  return { embeds: [embed], components };
}

module.exports = { criarConfirmacao };
