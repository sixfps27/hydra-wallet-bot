const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { formatarDinheiro } = require("../utils/money");
const { COLORS, FOOTER } = require("./theme");

function criarCarteiraView({ usuario, carteira, modo }) {
  const ambiente = modo === "mock" ? "Ambiente de testes" : "Sistema online";
  const status = carteira.reservado > 0 ? "🟡 Movimentação em processamento" : "🟢 Conta ativa";

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({
      name: "HYDRA SYSTEMS",
      iconURL: usuario.client?.user?.displayAvatarURL?.() || undefined
    })
    .setTitle("Painel financeiro")
    .setDescription([
      `Olá, ${usuario}.`,
      "Gerencie seu saldo e suas movimentações com segurança.",
      "",
      "### Saldo disponível",
      `# ${formatarDinheiro(carteira.saldo)}`
    ].join("\n"))
    .addFields(
      { name: "⏳ Em processamento", value: `**${formatarDinheiro(carteira.reservado)}**`, inline: true },
      { name: "🛡️ Status da conta", value: status, inline: true },
      { name: "🌐 Ambiente", value: ambiente, inline: true }
    )
    .setThumbnail(usuario.displayAvatarURL({ size: 256 }))
    .setFooter({ text: FOOTER })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("depositar").setLabel("Depositar").setEmoji("💰").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("enviar_pix").setLabel("Transferir").setEmoji("📤").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("extrato").setLabel("Extrato").setEmoji("📄").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

module.exports = { criarCarteiraView };
