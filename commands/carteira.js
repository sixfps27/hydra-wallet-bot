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
    .setDescription("Abre seu painel financeiro da Hydra Systems")
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
    const carteira = obterCarteira(interaction.user.id);
    const visual = criarCarteiraView({
      usuario: interaction.user,
      carteira,
      modo: process.env.PAYMENT_MODE || "mock"
    });

    const resultadoCanal = await garantirPerfilECanalPrivado({
      client: interaction.client,
      user: interaction.user
    }).catch(error => {
      console.error(`Erro ao preparar perfil privado de ${interaction.user.id}:`, error);
      return null;
    });

    // Quando o canal acabou de ser criado, já publica a carteira nele.
    // Isso confirma visualmente que o /carteira gerou o canal privado correto.
    if (resultadoCanal?.criado && resultadoCanal.canal?.isTextBased()) {
      await resultadoCanal.canal.send(visual).catch(error => {
        console.error(`Erro ao publicar carteira no canal privado de ${interaction.user.id}:`, error.message);
      });
    }

    await interaction.reply({
      ...visual,
      flags: MessageFlags.Ephemeral
    });
  }
};
