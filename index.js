require("dotenv").config();

const {
  Client, GatewayIntentBits, Events, ActivityType, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  EmbedBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle
} = require("discord.js");
const QRCode = require("qrcode");
const crypto = require("crypto");

const carteiraCommand = require("./commands/carteira");
const enviarCommand = require("./commands/enviar");
const { extrairChavePixDaMensagem } = require("./utils/pixMessage");
const { converterValor, formatarDinheiro } = require("./utils/money");
const { criarCarregamento } = require("./views/loadingView");
const { criarSucesso, criarComprovante } = require("./views/comprovanteView");
const {
  obterCarteira, obterPagamento, atualizarPagamento,
  reservarSaldo, concluirPagamento, falharPagamento,
  corrigirPagamentoConcluidoAposEstorno,
  listarPagamentosReconciliaveis,
  criarDeposito, obterDeposito, marcarDepositoPago, atualizarStatusDeposito,
  definirCooldown, obterCooldown
} = require("./store");
const { processarEnvioPix, verificarEnvioPix } = require("./services/walletManager");
const { criarCobrancaPix, consultarCobrancaPix } = require("./services/turbofyGateway");

if (!process.env.TOKEN) {
  console.error("TOKEN não encontrado no .env");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const depositosPendentes = new Map();
const pagamentosPorMensagemPendentes = new Map();
const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
const COOLDOWN_ENVIO_MS = Number(process.env.PIX_ERROR_COOLDOWN_MS || 60000);

function mensagemCooldown(cooldown) {
  const segundos = Math.max(1, Math.ceil(cooldown.restanteMs / 1000));
  return `Aguarde **${segundos} segundo${segundos === 1 ? "" : "s"}** para tentar novamente. Esse intervalo protege a saúde da API de pagamentos.`;
}

function aplicarCooldownDeErro(userId, motivo = "payment_error") {
  return definirCooldown(userId, "pix_send", COOLDOWN_ENVIO_MS, motivo);
}

function criarModalValorMensagem(referenciaId) {
  const modal = new ModalBuilder()
    .setCustomId(`modal_enviar_mensagem:${referenciaId}`)
    .setTitle("Pagar chave da mensagem");

  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId("valor_pix_mensagem")
      .setLabel("Valor do Pix")
      .setPlaceholder("6,00")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
  ));

  return modal;
}

function criarModalDeposito() {
  const modal = new ModalBuilder().setCustomId("modal_deposito").setTitle("Depositar");
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId("valor_deposito").setLabel("Valor").setPlaceholder("10,00").setStyle(TextInputStyle.Short).setRequired(true)
  ));
  return modal;
}

const STATUS_PAYOUT_SUCESSO = new Set([
  "paid", "completed", "concluido", "success", "succeeded", "done"
]);

const STATUS_PAYOUT_FALHA = new Set([
  "failed", "failure", "cancelled", "canceled", "denied", "rejected", "expired", "error"
]);

function normalizarStatusPayout(consulta) {
  const status = String(consulta?.status || "").toLowerCase();
  const paidItems = Number(consulta?.paidItems || 0);
  const failedItems = Number(consulta?.failedItems || 0);

  if (paidItems > 0) return { tipo: "sucesso", status: status || "paid" };
  if (failedItems > 0 && paidItems === 0) return { tipo: "falha", status: status || "failed" };
  if (STATUS_PAYOUT_SUCESSO.has(status)) return { tipo: "sucesso", status };
  if (STATUS_PAYOUT_FALHA.has(status)) return { tipo: "falha", status };
  return { tipo: "pendente", status: status || "processing" };
}

async function aguardarResultadoPayout(batchId, { intervalosMs } = {}) {
  const intervalos = Array.isArray(intervalosMs) && intervalosMs.length
    ? intervalosMs
    : [1200, 1500, 2000, 2000, 3000, 3000, 5000, 5000, 8000];

  let ultimaConsulta = null;

  // Consulta imediatamente antes de esperar.
  for (let tentativa = 0; tentativa <= intervalos.length; tentativa++) {
    ultimaConsulta = await verificarEnvioPix(batchId);
    const resultado = normalizarStatusPayout(ultimaConsulta);

    if (resultado.tipo !== "pendente") {
      return { ...resultado, consulta: ultimaConsulta };
    }

    if (tentativa < intervalos.length) {
      await esperar(intervalos[tentativa]);
    }
  }

  return {
    tipo: "pendente",
    status: normalizarStatusPayout(ultimaConsulta).status,
    consulta: ultimaConsulta
  };
}

function extrairDadosPayout(consulta = {}) {
  const item = Array.isArray(consulta.items) ? consulta.items[0] || {} : {};
  return {
    nomeDestinatario: item.recipientName || consulta.recipientName || null,
    documentoDestinatario: item.recipientDocument || consulta.recipientDocument || null,
    payoutId: item.id || consulta.payoutId || null,
    endToEndId: item.endToEndId || item.endToEnd || consulta.endToEndId || null,
    liquidadoEm: item.settledAt || consulta.settledAt || null
  };
}

async function reconciliarPagamento(pagamento) {
  if (!pagamento?.batchId || !["processando", "falhou"].includes(pagamento.status)) return null;

  const consulta = await verificarEnvioPix(pagamento.batchId);
  const resultado = normalizarStatusPayout(consulta);
  const dadosPayout = extrairDadosPayout(consulta);
  atualizarPagamento(pagamento.id, {
    gatewayStatus: resultado.status,
    nomeDestinatario: dadosPayout.nomeDestinatario || pagamento.nomeDestinatario,
    documentoDestinatario: dadosPayout.documentoDestinatario || pagamento.documentoDestinatario,
    payoutId: dadosPayout.payoutId,
    endToEndId: dadosPayout.endToEndId
  });

  if (resultado.tipo === "sucesso") {
    const atual = obterPagamento(pagamento.id);
    if (atual.status === "falhou") {
      console.warn(`Corrigindo estorno indevido do pagamento ${pagamento.id}.`);
      return corrigirPagamentoConcluidoAposEstorno(atual, pagamento.batchId, resultado.status);
    }
    return concluirPagamento(atual, pagamento.batchId, resultado.status);
  }

  if (resultado.tipo === "falha" && pagamento.status === "processando") {
    const falhado = falharPagamento(obterPagamento(pagamento.id), resultado.status);
    aplicarCooldownDeErro(pagamento.usuarioId, resultado.status);
    return falhado;
  }

  return obterPagamento(pagamento.id);
}

async function reconciliarPagamentosPendentes() {
  const pendentes = listarPagamentosReconciliaveis();
  for (const pagamento of pendentes) {
    try {
      await reconciliarPagamento(pagamento);
    } catch (erro) {
      console.error(`Erro ao reconciliar pagamento ${pagamento.id}:`, erro.code || erro.message);
    }
  }
}

async function confirmarDepositoPago(depositoId) {
  const deposito = obterDeposito(depositoId);
  if (!deposito) throw new Error("DEPOSITO_NAO_ENCONTRADO");
  if (deposito.creditadoEm) return { pago: true, deposito };

  const cobranca = await consultarCobrancaPix(deposito.gatewayId);
  const status = String(cobranca?.status || "").toLowerCase();
  atualizarStatusDeposito(deposito.id, status || "unknown");
  const pago = ["paid", "completed", "succeeded", "success", "concluido"].includes(status);
  if (!pago) return { pago: false, status, deposito: obterDeposito(deposito.id) };
  return { pago: true, status, deposito: marcarDepositoPago(deposito.id, status) };
}

async function monitorarDeposito({ interaction, depositoId }) {
  for (let tentativa = 0; tentativa < 60; tentativa++) {
    await esperar(10000);
    const deposito = obterDeposito(depositoId);
    if (!deposito || deposito.creditadoEm || (deposito.expiraEm && Date.now() > deposito.expiraEm)) return;
    try {
      const resultado = await confirmarDepositoPago(depositoId);
      if (!resultado.pago) continue;
      const saldo = obterCarteira(deposito.usuarioId).saldo;
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor("#22C55E").setTitle("Depósito confirmado").setDescription(`Saldo adicionado: **${formatarDinheiro(resultado.deposito.valorLiquido)}**\n\nSaldo atual: **${formatarDinheiro(saldo)}**`).setFooter({ text: "Hydra Wallet" })],
        components: [], attachments: []
      }).catch(() => {});
      return;
    } catch (erro) { console.error("Erro ao consultar depósito:", erro.code, erro.message); }
  }
}

client.once(Events.ClientReady, bot => {
  console.log(`✅ ${bot.user.tag} está online!`);
  console.log(`💳 Modo: ${process.env.PAYMENT_MODE || "mock"}`);
  bot.user.setActivity("Hydra Wallet", { type: ActivityType.Watching });

  reconciliarPagamentosPendentes().catch(erro => {
    console.error("Erro na reconciliação inicial:", erro);
  });

  const intervalo = Number(process.env.PAYOUT_RECONCILE_INTERVAL_MS || 5000);
  setInterval(() => {
    reconciliarPagamentosPendentes().catch(erro => {
      console.error("Erro na reconciliação periódica:", erro);
    });
  }, intervalo).unref();
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "carteira") return carteiraCommand.execute(interaction);
      if (interaction.commandName === "enviar") return enviarCommand.execute(interaction);
      return;
    }

    if (interaction.isMessageContextMenuCommand()) {
      const chave = extrairChavePixDaMensagem(interaction.targetMessage?.content);
      if (!chave) {
        return interaction.reply({
          content: "Não encontrei uma chave Pix válida nessa mensagem. Peça para a pessoa enviar somente a chave Pix ou use `/enviar`.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.commandName === "Copiar chave Pix") {
        const arquivo = new AttachmentBuilder(Buffer.from(chave, "utf8"), { name: "chave-pix.txt" });
        return interaction.reply({
          content: `**Chave Pix encontrada**

${chave}

Toque e segure para copiar. Se preferir, abra o arquivo anexado.`,
          files: [arquivo],
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.commandName === "Pagar esta chave") {
        const referenciaId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
        pagamentosPorMensagemPendentes.set(referenciaId, {
          usuarioId: interaction.user.id,
          chave,
          criadoEm: Date.now()
        });
        setTimeout(() => pagamentosPorMensagemPendentes.delete(referenciaId), 10 * 60 * 1000).unref();
        return interaction.showModal(criarModalValorMensagem(referenciaId));
      }
    }

    if (interaction.isButton() && interaction.customId === "depositar") {
      return interaction.showModal(criarModalDeposito());
    }

    if (interaction.isButton() && interaction.customId === "enviar_pix") {
      return interaction.showModal(enviarCommand.criarModalEnviar());
    }

    if (interaction.isModalSubmit() && interaction.customId === "modal_enviar_pix") {
      const chave = interaction.fields.getTextInputValue("chave_pix");
      const valor = converterValor(interaction.fields.getTextInputValue("valor_pix"));
      return enviarCommand.preparar(interaction, chave, valor);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_enviar_mensagem:")) {
      const referenciaId = interaction.customId.split(":")[1];
      const pendente = pagamentosPorMensagemPendentes.get(referenciaId);
      pagamentosPorMensagemPendentes.delete(referenciaId);

      if (!pendente || pendente.usuarioId !== interaction.user.id || Date.now() - pendente.criadoEm > 10 * 60 * 1000) {
        return interaction.reply({
          content: "Essa solicitação expirou. Segure a mensagem novamente e escolha **Apps → Pagar esta chave**.",
          flags: MessageFlags.Ephemeral
        });
      }

      const valor = converterValor(interaction.fields.getTextInputValue("valor_pix_mensagem"));
      return enviarCommand.preparar(interaction, pendente.chave, valor);
    }

    if (interaction.isModalSubmit() && interaction.customId === "modal_deposito") {
      const valor = converterValor(interaction.fields.getTextInputValue("valor_deposito"));
      if (!Number.isFinite(valor) || valor < 1 || valor > 10000) {
        return interaction.reply({ content: "Digite um valor entre R$ 1,00 e R$ 10.000,00.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const taxaTurbofyPercentual = Number(process.env.TURBOFY_DEPOSIT_FEE_PERCENT || 2.5);
        const taxaHydraPercentual = Number(process.env.HYDRA_DEPOSIT_FEE_PERCENT || 0.5);

        if (
          !Number.isFinite(taxaTurbofyPercentual) || taxaTurbofyPercentual < 0 ||
          !Number.isFinite(taxaHydraPercentual) || taxaHydraPercentual < 0
        ) throw new Error("CONFIGURACAO_TAXA_DEPOSITO_INVALIDA");

        const valorCents = Math.round(valor * 100);
        const taxaTurbofyCents = Math.round(valorCents * (taxaTurbofyPercentual / 100));
        const taxaHydraCents = Math.round(valorCents * (taxaHydraPercentual / 100));
        const taxaTotalCents = taxaTurbofyCents + taxaHydraCents;
        const liquidoCents = valorCents - taxaTotalCents;
        if (liquidoCents <= 0) throw new Error("VALOR_LIQUIDO_INVALIDO");

        const taxaTurbofy = taxaTurbofyCents / 100;
        const taxaHydra = taxaHydraCents / 100;
        const taxa = taxaTotalCents / 100;
        const liquido = liquidoCents / 100;
        const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
        const expiraEm = new Date(Date.now() + 15 * 60 * 1000);

        if ((process.env.PAYMENT_MODE || "mock") !== "turbofy") {
          const codigo = `HYDRA-PIX-TESTE-${id}-${valor.toFixed(2)}-${interaction.user.id}`;
          const buffer = await QRCode.toBuffer(codigo, { type: "png", width: 500, margin: 2 });
          const arquivo = `pix-${id}.png`;
          depositosPendentes.set(id, { usuarioId: interaction.user.id, codigo, expiraEm: expiraEm.getTime() });
          const embed = new EmbedBuilder().setColor("#2563EB").setTitle("Depositar")
            .setDescription(
              `**${formatarDinheiro(valor)}**\n\n` +
              `Taxa Turbofy (${taxaTurbofyPercentual}%): **${formatarDinheiro(taxaTurbofy)}**\n` +
              `Taxa Hydra Systems (${taxaHydraPercentual}%): **${formatarDinheiro(taxaHydra)}**\n\n` +
              `Saldo que será creditado: **${formatarDinheiro(liquido)}**\n\nAmbiente de testes.`
            )
            .setImage(`attachment://${arquivo}`).setFooter({ text: "Hydra Wallet" });
          const components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`copiar_pix:${id}`).setLabel("Pix copia e cola").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`cancelar_deposito:${id}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
          )];
          return interaction.editReply({ embeds: [embed], components, files: [new AttachmentBuilder(buffer, { name: arquivo })] });
        }

        const cobranca = await criarCobrancaPix({
          amountCents: valorCents,
          description: "Depósito Hydra Wallet",
          externalRef: `hydra-deposit-${id}`,
          expiresAt: expiraEm.toISOString(),
          metadata: {
            hydraDepositId: id,
            discordUserId: interaction.user.id,
            grossAmountCents: valorCents,
            turbofyFeeCents: taxaTurbofyCents,
            hydraFeeCents: taxaHydraCents,
            totalFeeCents: taxaTotalCents,
            netAmountCents: liquidoCents
          }
        });

        const copiaECola = cobranca?.pix?.copyPaste;
        if (!cobranca?.id || !copiaECola) throw new Error("RESPOSTA_COBRANCA_INVALIDA");

        criarDeposito({
          id, usuarioId: interaction.user.id, gatewayId: cobranca.id,
          valorBruto: valor,
          taxa,
          taxaProvedor: taxaTurbofy,
          taxaAdmin: taxaHydra,
          valorLiquido: liquido,
          copiaECola,
          expiraEm: new Date(cobranca?.pix?.expiresAt || expiraEm).getTime()
        });

        const buffer = await QRCode.toBuffer(copiaECola, { type: "png", width: 500, margin: 2 });
        const arquivo = `pix-${id}.png`;
        const embed = new EmbedBuilder().setColor("#2563EB").setTitle("Depositar")
          .setDescription(
            `**${formatarDinheiro(valor)}**\n\n` +
            `Taxa Turbofy (${taxaTurbofyPercentual}%): **${formatarDinheiro(taxaTurbofy)}**\n` +
            `Taxa Hydra Systems (${taxaHydraPercentual}%): **${formatarDinheiro(taxaHydra)}**\n\n` +
            `Saldo que será creditado: **${formatarDinheiro(liquido)}**\n\nAguardando pagamento.`
          )
          .setImage(`attachment://${arquivo}`).setFooter({ text: "Hydra Wallet" });
        const components = [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`copiar_pix_real:${id}`).setLabel("Pix copia e cola").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`verificar_deposito:${id}`).setLabel("Já paguei").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`cancelar_deposito:${id}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
        )];

        await interaction.editReply({ embeds: [embed], components, files: [new AttachmentBuilder(buffer, { name: arquivo })] });

        monitorarDeposito({ interaction, depositoId: id }).catch(erro => console.error("Monitor de depósito:", erro));
        return;
      } catch (erro) {
        console.error("Erro ao criar cobrança Pix:", erro.code, erro.message, erro.details || "");
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor("#EF4444").setTitle("Não foi possível gerar o Pix").setDescription("Tente novamente em alguns instantes.").setFooter({ text: "Hydra Wallet" })], components: [] });
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith("copiar_pix_real:")) {
      const deposito = obterDeposito(interaction.customId.split(":")[1]);
      if (!deposito || deposito.usuarioId !== interaction.user.id) return interaction.reply({ content: "Depósito não encontrado.", flags: MessageFlags.Ephemeral });
      const arquivo = new AttachmentBuilder(Buffer.from(deposito.copiaECola, "utf8"), { name: "pix-copia-e-cola.txt" });
      return interaction.reply({
        content: `**Pix Copia e Cola**\n\nToque e segure o código abaixo para copiar:\n\n${deposito.copiaECola}\n\nSe preferir, abra o arquivo anexado.`,
        files: [arquivo],
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith("verificar_deposito:")) {
      const id = interaction.customId.split(":")[1];
      const deposito = obterDeposito(id);
      if (!deposito || deposito.usuarioId !== interaction.user.id) return interaction.reply({ content: "Depósito não encontrado.", flags: MessageFlags.Ephemeral });
      await interaction.deferUpdate();
      try {
        const resultado = await confirmarDepositoPago(id);
        if (!resultado.pago) {
          return interaction.followUp({ content: "O pagamento ainda não foi confirmado pela Turbofy.", flags: MessageFlags.Ephemeral });
        }
        const saldo = obterCarteira(interaction.user.id).saldo;
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor("#22C55E").setTitle("Depósito confirmado").setDescription(`Saldo adicionado: **${formatarDinheiro(resultado.deposito.valorLiquido)}**\n\nSaldo atual: **${formatarDinheiro(saldo)}**`).setFooter({ text: "Hydra Wallet" })], components: [], attachments: [] });
      } catch (erro) {
        console.error("Erro ao verificar depósito:", erro.code, erro.message, erro.details || "");
        return interaction.followUp({ content: "Não consegui verificar agora. Tente novamente em alguns segundos.", flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith("confirmar_pix:")) {
      const id = interaction.customId.split(":")[1];
      let pagamento = obterPagamento(id);
      if (!pagamento || pagamento.usuarioId !== interaction.user.id) return interaction.reply({ content: "Pagamento não encontrado.", flags: MessageFlags.Ephemeral });
      if (pagamento.status !== "aguardando_confirmacao") return interaction.reply({ content: "Esse pagamento já foi processado.", flags: MessageFlags.Ephemeral });
      const cooldown = obterCooldown(interaction.user.id, "pix_send");
      if (cooldown.ativo) {
        return interaction.update({
          embeds: [new EmbedBuilder().setColor("#F59E0B").setTitle("Aguarde para tentar novamente").setDescription(mensagemCooldown(cooldown)).setFooter({ text: "Hydra Wallet" })],
          components: []
        });
      }

      try { reservarSaldo(pagamento); }
      catch (e) {
        if (e.message === "SALDO_INSUFICIENTE") return interaction.update({ embeds: [new EmbedBuilder().setColor("#EF4444").setTitle("Saldo insuficiente")], components: [] });
        throw e;
      }

      await interaction.update(criarCarregamento({ valor: pagamento.valor, chave: pagamento.chave }));

      try {
        const resultado = await processarEnvioPix({
          usuarioId: interaction.user.id,
          chavePix: pagamento.chave,
          valor: pagamento.valor,
          nomeDestinatario: pagamento.nomeDestinatario,
          documentoDestinatario: pagamento.documentoDestinatario || process.env.TURBOFY_FALLBACK_RECIPIENT_DOCUMENT || "00000000000",
          referencia: pagamento.id
        });
        const batchId = resultado.batchId;
        atualizarPagamento(id, { batchId, gatewayStatus: resultado.status || "processing" });

        const resultadoFinal = await aguardarResultadoPayout(batchId);
        const dadosPayout = extrairDadosPayout(resultadoFinal.consulta);

        atualizarPagamento(id, {
          gatewayStatus: resultadoFinal.status,
          nomeDestinatario: dadosPayout.nomeDestinatario || pagamento.nomeDestinatario,
          documentoDestinatario: dadosPayout.documentoDestinatario || pagamento.documentoDestinatario,
          payoutId: dadosPayout.payoutId,
          endToEndId: dadosPayout.endToEndId
        });

        if (resultadoFinal.tipo === "sucesso") {
          pagamento = concluirPagamento(obterPagamento(id), batchId, resultadoFinal.status);
          const saldo = obterCarteira(interaction.user.id).saldo;
          return interaction.editReply(criarSucesso({ pagamento, saldo }));
        }

        if (resultadoFinal.tipo === "falha") {
          pagamento = falharPagamento(obterPagamento(id), resultadoFinal.status);
          aplicarCooldownDeErro(interaction.user.id, resultadoFinal.status);
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor("#EF4444")
              .setTitle("Pagamento não realizado")
              .setDescription("A Turbofy confirmou a falha. O valor voltou para sua carteira. Aguarde **1 minuto** antes de tentar novamente.")
              .setFooter({ text: "Hydra Wallet" })],
            components: []
          });
        }

        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor("#F59E0B")
            .setTitle("Pagamento em processamento")
            .setDescription("A Turbofy recebeu o pagamento e ainda está processando. O valor continuará reservado até a confirmação final.")
            .setFooter({ text: "Hydra Wallet" })],
          components: []
        });
      } catch (erro) {
        console.error("Erro no pagamento:", erro);
        pagamento = obterPagamento(id);

        // Erros 4xx recebidos antes da criação do lote significam que nenhum payout foi aceito.
        // Nesses casos é seguro devolver o valor. Erros de rede/5xx após a criação são incertos:
        // o saldo permanece reservado para evitar pagamento duplicado.
        const batchCriado = Boolean(pagamento?.batchId);
        const rejeicaoDefinitivaSemBatch = !batchCriado && Number(erro.status) >= 400 && Number(erro.status) < 500;

        if (pagamento?.status === "processando" && rejeicaoDefinitivaSemBatch) {
          falharPagamento(pagamento, erro.code || erro.message);
          aplicarCooldownDeErro(interaction.user.id, erro.code || erro.message);
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor("#EF4444")
              .setTitle("Pagamento não realizado")
              .setDescription("A Turbofy recusou a solicitação. O valor voltou para sua carteira. Aguarde **1 minuto** antes de tentar novamente.")
              .setFooter({ text: "Hydra Wallet" })],
            components: []
          });
        }

        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor("#F59E0B")
            .setTitle("Pagamento em análise")
            .setDescription("Não foi possível confirmar o resultado agora. Por segurança, o valor continuará reservado até consultarmos a Turbofy novamente.")
            .setFooter({ text: "Hydra Wallet" })],
          components: []
        });
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith("cancelar_pix:")) {
      const id = interaction.customId.split(":")[1];
      const p = obterPagamento(id);
      if (!p || p.usuarioId !== interaction.user.id) return interaction.reply({ content: "Pagamento não encontrado.", flags: MessageFlags.Ephemeral });
      if (p.status !== "aguardando_confirmacao") return interaction.reply({ content: "Não é mais possível cancelar.", flags: MessageFlags.Ephemeral });
      atualizarPagamento(id, { status: "cancelado" });
      return interaction.update({ embeds: [new EmbedBuilder().setColor("#6B7280").setTitle("Pagamento cancelado").setFooter({ text: "Hydra Wallet" })], components: [] });
    }

    if (interaction.isButton() && interaction.customId.startsWith("comprovante:")) {
      const p = obterPagamento(interaction.customId.split(":")[1]);
      if (!p || p.usuarioId !== interaction.user.id || p.status !== "concluido") return interaction.reply({ content: "Comprovante não encontrado.", flags: MessageFlags.Ephemeral });
      return interaction.reply({ ...criarComprovante({ pagamento: p, pagador: interaction.user }), flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId.startsWith("copiar_pix:")) {
      const d = depositosPendentes.get(interaction.customId.split(":")[1]);
      if (!d || d.usuarioId !== interaction.user.id || Date.now() > d.expiraEm) return interaction.reply({ content: "Esse depósito expirou.", flags: MessageFlags.Ephemeral });
      const arquivo = new AttachmentBuilder(Buffer.from(d.codigo, "utf8"), { name: "pix-copia-e-cola.txt" });
      return interaction.reply({ content: `**Pix Copia e Cola**\n\nToque e segure o código abaixo para copiar:\n\n${d.codigo}`, files: [arquivo], flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId.startsWith("cancelar_deposito:")) {
      const id = interaction.customId.split(":")[1];
      depositosPendentes.delete(id);
      const deposito = obterDeposito(id);
      if (deposito && deposito.usuarioId !== interaction.user.id) return interaction.reply({ content: "Depósito não encontrado.", flags: MessageFlags.Ephemeral });
      if (deposito && !deposito.creditadoEm) atualizarStatusDeposito(id, "cancelled");
      return interaction.update({ embeds: [new EmbedBuilder().setColor("#6B7280").setTitle("Depósito cancelado")], components: [], attachments: [] });
    }

    if (interaction.isButton() && interaction.customId === "extrato") {
      const carteira = obterCarteira(interaction.user.id);
      if (!carteira.extrato.length) return interaction.reply({ content: "Você ainda não possui movimentações.", flags: MessageFlags.Ephemeral });
      const texto = carteira.extrato.slice(0, 10).map(item => `${item.tipo === "pix_enviado" ? "Enviado" : "Crédito"} — **${formatarDinheiro(item.valor)}**\n${item.nome}`).join("\n\n");
      return interaction.reply({ embeds: [new EmbedBuilder().setColor("#2563EB").setTitle("Extrato").setDescription(texto).setFooter({ text: "Hydra Wallet" })], flags: MessageFlags.Ephemeral });
    }
  } catch (erro) {
    console.error("Erro na interação:", erro);
    const resposta = { content: "Ocorreu um erro. Tente novamente.", flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(resposta).catch(() => {});
    else await interaction.reply(resposta).catch(() => {});
  }
});

client.login(process.env.TOKEN).catch(error => {
  console.error("Não foi possível ligar o bot:", error.message);
});
