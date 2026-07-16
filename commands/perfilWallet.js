const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { obterCarteira, obterPerfil, listarTransacoesUsuario } = require("../store");
const { formatarDinheiro } = require("../utils/money");
const { COLORS, FOOTER } = require("../views/theme");

function admin(interaction) { return interaction.member?.roles?.cache?.has(process.env.HYDRA_ADMIN_ROLE_ID); }

module.exports = {
  data: new SlashCommandBuilder()
    .setName("perfil-wallet")
    .setDescription("Mostra o perfil financeiro de um cliente")
    .addUserOption(o => o.setName("usuario").setDescription("Cliente").setRequired(true)),

  async execute(interaction) {
    if (!admin(interaction)) return interaction.reply({ content: "Você não tem permissão.", flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser("usuario", true);
    const carteira = obterCarteira(user.id);
    const perfil = obterPerfil(user.id);
    const tx = listarTransacoesUsuario(user.id, 5);
    const texto = tx.length
      ? tx.map(t => `${t.tipo === "pix_enviado" ? "🔴" : "🟢"} **${formatarDinheiro(t.valor)}** — ${t.descricao}`).join("\n")
      : "Sem movimentações recentes.";

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.accent)
          .setAuthor({ name: "HYDRA SYSTEMS • PERFIL" })
          .setTitle(`Conta de ${user.username}`)
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: "👤 Cliente", value: `${user}\n\`${user.id}\``, inline: false },
            { name: "💰 Saldo disponível", value: `**${formatarDinheiro(carteira.saldo)}**`, inline: true },
            { name: "⏳ Em processamento", value: `**${formatarDinheiro(carteira.reservado)}**`, inline: true },
            { name: "🛡️ Status", value: perfil?.status || "active", inline: true },
            { name: "🔒 Canal privado", value: perfil?.privateChannelId ? `<#${perfil.privateChannelId}>` : "Ainda não criado", inline: false },
            { name: "📄 Últimas movimentações", value: texto, inline: false }
          )
          .setFooter({ text: FOOTER })
          .setTimestamp()
      ],
      flags: MessageFlags.Ephemeral
    });
  }
};
