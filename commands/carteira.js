const { SlashCommandBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } = require("discord.js");
const { obterCarteira } = require("../store");
const { criarCarteiraView } = require("../views/carteiraView");
module.exports = {
 data: new SlashCommandBuilder().setName("carteira").setDescription("Mostra sua Hydra Wallet")
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall,ApplicationIntegrationType.UserInstall)
  .setContexts(InteractionContextType.Guild,InteractionContextType.BotDM,InteractionContextType.PrivateChannel),
 async execute(interaction){ await interaction.reply({...criarCarteiraView({usuario:interaction.user,carteira:obterCarteira(interaction.user.id),modo:process.env.PAYMENT_MODE||"mock"}),flags:MessageFlags.Ephemeral}); }
};
