const {
  SlashCommandBuilder,
  MessageFlags,
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord.js");

const { obterCarteira } = require("../store");
const { criarCarteiraView } = require("../views/carteiraView");
const { garantirPerfilECanalPrivado } = require("../services/profileChannelService");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("carteira")
    .setDescription("Mostra sua Hydra Systems Wallet")
    .setIntegrationTypes(
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall
    )
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel
    ),

  async execute(interaction) {
    // A criação do perfil/canal não altera saldo. Se o Discord negar a criação,
    // a carteira continua abrindo normalmente.
    garantirPerfilECanalPrivado({
      client: interaction.client,
      user: interaction.user
    }).catch(error => {
      console.error(`Erro ao preparar perfil privado de ${interaction.user.id}:`, error);
    });

    await interaction.reply({
      ...criarCarteiraView({
        usuario: interaction.user,
        carteira: obterCarteira(interaction.user.id),
        modo: process.env.PAYMENT_MODE || "mock"
      }),
      flags: MessageFlags.Ephemeral
    });
  }
};
