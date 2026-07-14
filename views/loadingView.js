const { EmbedBuilder } = require("discord.js");
const { formatarDinheiro } = require("../utils/money");

function criarCarregamento({ valor, chave }) {
  return {
    embeds: [new EmbedBuilder()
      .setColor("#F59E0B")
      .setTitle("Enviando pagamento...")
      .setDescription(`**${formatarDinheiro(valor)}** para \`${chave}\``)
      .setFooter({ text: "Hydra Wallet" })],
    components: []
  };
}
module.exports = { criarCarregamento };
