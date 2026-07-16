const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");
const { obterResumoAdmin, listarPerfis } = require("../store");
const { formatarDinheiro } = require("../utils/money");
const { COLORS, FOOTER } = require("../views/theme");

function admin(i) { return i.member?.roles?.cache?.has(process.env.HYDRA_ADMIN_ROLE_ID); }

module.exports = {
  data: new SlashCommandBuilder()
    .setName("admin-wallet")
    .setDescription("Abre o painel administrativo da Hydra Systems"),
  async execute(i) {
    if (!admin(i)) return i.reply({ content: "Você não tem permissão.", flags: MessageFlags.Ephemeral });
    const r = obterResumoAdmin();
    const recentes = listarPerfis(8)
      .map(p => `• **${p.username}** — ${formatarDinheiro(p.saldo)} — ${p.status}`)
      .join("\n") || "Nenhuma conta cadastrada.";

    return i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.primary)
          .setAuthor({ name: "HYDRA SYSTEMS • ADMIN" })
          .setTitle("Central financeira")
          .setDescription("Visão geral da operação em tempo real.")
          .addFields(
            { name: "👥 Clientes", value: `**${r.clientes}**`, inline: true },
            { name: "💰 Saldo interno", value: `**${formatarDinheiro(r.saldo)}**`, inline: true },
            { name: "⏳ Em processamento", value: `**${formatarDinheiro(r.reservado)}**`, inline: true },
            { name: "🟡 Pagamentos pendentes", value: `**${r.pendentes}**`, inline: true },
            { name: "🔒 Contas bloqueadas", value: `**${r.bloqueadas}**`, inline: true },
            { name: "🕘 Contas recentes", value: recentes, inline: false }
          )
          .setFooter({ text: FOOTER })
          .setTimestamp()
      ],
      flags: MessageFlags.Ephemeral
    });
  }
};
