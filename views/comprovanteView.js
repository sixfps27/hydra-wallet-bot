const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { formatarDinheiro } = require("../utils/money");

function mascararDocumento(documento) {
  const numeros = String(documento || "").replace(/\D/g, "");
  if (!numeros) return "Não informado";
  if (numeros.length === 11) return `***.***.${numeros.slice(6, 9)}-${numeros.slice(-2)}`;
  if (numeros.length === 14) return `**.***.***/****-${numeros.slice(-2)}`;
  return `***${numeros.slice(-3)}`;
}

function formatarData(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function criarSucesso({ pagamento, saldo }) {
  return {
    embeds: [new EmbedBuilder()
      .setColor("#22C55E")
      .setTitle("Pagamento enviado")
      .setDescription(`**${formatarDinheiro(pagamento.valor)}**\n\nPara\n\`${pagamento.chave}\``)
      .addFields({ name: "Saldo", value: `**${formatarDinheiro(saldo)}**` })
      .setFooter({ text: "Hydra Wallet" })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`comprovante:${pagamento.id}`).setLabel("Ver comprovante").setStyle(ButtonStyle.Secondary)
    )]
  };
}

function criarComprovante({ pagamento, pagador }) {
  const nomePagador = pagador?.globalName || pagador?.displayName || pagador?.username || "Usuário Hydra";
  const nomeRecebedor = pagamento.nomeDestinatario && pagamento.nomeDestinatario !== "Destinatário"
    ? pagamento.nomeDestinatario
    : "Titular da chave Pix";

  const campos = [
    { name: "Dados do pagador", value: `**Nome:** ${nomePagador}\n**Conta:** Hydra Wallet`, inline: false },
    { name: "Dados do recebedor", value: `**Nome:** ${nomeRecebedor}\n**Chave Pix:** \`${pagamento.chave}\`\n**CPF/CNPJ:** ${mascararDocumento(pagamento.documentoDestinatario)}\n**Instituição:** TurbofyPay`, inline: false },
    { name: "Descrição", value: `**Forma de pagamento:** Pix\n**Valor:** ${formatarDinheiro(pagamento.valor)}\n**Data:** ${formatarData(pagamento.concluidoEm)}\n**Status:** Pago`, inline: false },
    { name: "Código Hydra", value: `\`${pagamento.codigoHydra}\``, inline: false }
  ];

  if (pagamento.endToEndId) {
    campos.push({ name: "EndToEndId", value: `\`${pagamento.endToEndId}\``, inline: false });
  } else if (pagamento.payoutId) {
    campos.push({ name: "ID da transação", value: `\`${pagamento.payoutId}\``, inline: false });
  }

  return {
    embeds: [new EmbedBuilder()
      .setColor("#2563EB")
      .setTitle("Comprovante de transferência")
      .setDescription("Pagamento realizado com sucesso pela Hydra Wallet.")
      .addFields(campos)
      .setFooter({ text: "Hydra Wallet • Comprovante digital" })
      .setTimestamp(new Date(pagamento.concluidoEm || Date.now()))],
    components: []
  };
}

module.exports = { criarSucesso, criarComprovante };
