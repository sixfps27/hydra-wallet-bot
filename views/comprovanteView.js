const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { formatarDinheiro } = require("../utils/money");
const { COLORS, FOOTER } = require("./theme");

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
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.success)
        .setAuthor({ name: "HYDRA SYSTEMS" })
        .setTitle("Pix enviado com sucesso")
        .setDescription("Sua transferência foi concluída e registrada.")
        .addFields(
          { name: "💸 Valor enviado", value: `# ${formatarDinheiro(pagamento.valor)}`, inline: false },
          { name: "🔑 Destino", value: `\`${pagamento.chave}\``, inline: false },
          { name: "💰 Saldo disponível", value: `**${formatarDinheiro(saldo)}**`, inline: false }
        )
        .setFooter({ text: FOOTER })
        .setTimestamp()
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`comprovante:${pagamento.id}`)
          .setLabel("Ver comprovante")
          .setEmoji("🧾")
          .setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function criarComprovante({ pagamento, pagador }) {
  const nomePagador = process.env.HYDRA_PAYER_NAME || pagador?.globalName || pagador?.displayName || pagador?.username || "Turbofy Pagamentos";
  const documentoPagador = process.env.HYDRA_PAYER_DOCUMENT || null;
  const instituicaoPagador = process.env.HYDRA_PAYER_INSTITUTION || "TurbofyPay";
  const nomeRecebedor = pagamento.nomeDestinatario && pagamento.nomeDestinatario !== "Destinatário"
    ? pagamento.nomeDestinatario
    : "Titular da chave Pix";

  const campos = [
    { name: "🏦 Pagador", value: `**Nome:** ${nomePagador}\n**CPF/CNPJ:** ${mascararDocumento(documentoPagador)}\n**Instituição:** ${instituicaoPagador}`, inline: false },
    { name: "👤 Recebedor", value: `**Nome:** ${nomeRecebedor}\n**Chave Pix:** \`${pagamento.chave}\`\n**CPF/CNPJ:** ${mascararDocumento(pagamento.documentoDestinatario)}\n**Instituição:** TurbofyPay`, inline: false },
    { name: "📋 Detalhes da transação", value: `**Forma de pagamento:** Pix\n**Valor:** ${formatarDinheiro(pagamento.valor)}\n**Data e horário:** ${formatarData(pagamento.concluidoEm)}\n**Status:** Concluído`, inline: false },
    { name: "🔐 Código Hydra", value: `\`${pagamento.codigoHydra}\``, inline: false }
  ];

  if (pagamento.endToEndId) {
    campos.push({ name: "🔎 EndToEndId", value: `\`${pagamento.endToEndId}\``, inline: false });
  } else if (pagamento.payoutId) {
    campos.push({ name: "🔎 ID da transação", value: `\`${pagamento.payoutId}\``, inline: false });
  }

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.primary)
        .setAuthor({ name: "HYDRA SYSTEMS" })
        .setTitle("Comprovante de transferência Pix")
        .setDescription("Pagamento processado com sucesso. O comprovante oficial permanece anexado ao perfil privado do usuário.")
        .addFields(campos)
        .setFooter({ text: `${FOOTER} • Comprovante digital` })
        .setTimestamp(new Date(pagamento.concluidoEm || Date.now()))
    ],
    components: []
  };
}

module.exports = { criarSucesso, criarComprovante };
