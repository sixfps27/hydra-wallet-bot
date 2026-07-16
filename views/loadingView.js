const { EmbedBuilder } = require("discord.js");
const { formatarDinheiro } = require("../utils/money");
const { COLORS, FOOTER } = require("./theme");

function criarCarregamento({ valor, chave }) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.warning)
        .setAuthor({ name: "HYDRA SYSTEMS" })
        .setTitle("Processando sua transferência")
        .setDescription([
          "Aguarde enquanto confirmamos o pagamento com a instituição.",
          "",
          `**Valor:** ${formatarDinheiro(valor)}`,
          `**Destino:** \`${chave}\``,
          "",
          "⏳ Não faça outro pagamento para a mesma chave enquanto este estiver em análise."
        ].join("\n"))
        .setFooter({ text: FOOTER })
        .setTimestamp()
    ],
    components: []
  };
}

module.exports = { criarCarregamento };
