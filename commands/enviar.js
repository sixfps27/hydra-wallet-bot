const { SlashCommandBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ApplicationIntegrationType, InteractionContextType } = require("discord.js");
const { obterCarteira, criarPagamento } = require("../store");
const { converterValor, formatarDinheiro } = require("../utils/money");
const { chavePixValida, normalizarChavePix } = require("../utils/pix");
const { criarConfirmacao } = require("../views/confirmacaoView");

function criarModalEnviar(){ const m=new ModalBuilder().setCustomId("modal_enviar_pix").setTitle("Enviar Pix"); m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("chave_pix").setLabel("Chave Pix").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("valor_pix").setLabel("Valor").setPlaceholder("10,00").setStyle(TextInputStyle.Short).setRequired(true))); return m; }

async function preparar(interaction,chave,valor){
 chave=normalizarChavePix(chave);
 if(!chavePixValida(chave)) return interaction.reply({content:"Chave Pix inválida.",flags:MessageFlags.Ephemeral});
 if(!Number.isFinite(valor)||valor<=0) return interaction.reply({content:"Valor inválido.",flags:MessageFlags.Ephemeral});
 const carteira=obterCarteira(interaction.user.id);
 if(valor>carteira.saldo) return interaction.reply({content:`Saldo insuficiente. Seu saldo é **${formatarDinheiro(carteira.saldo)}**.`,flags:MessageFlags.Ephemeral});
 const p=criarPagamento({usuarioId:interaction.user.id,chave,valor,nomeDestinatario:"Destinatário"});
 await interaction.reply({...criarConfirmacao({chave,valor,saldoRestante:carteira.saldo-valor,pagamentoId:p.id}),flags:MessageFlags.Ephemeral});
}

module.exports={
 data:new SlashCommandBuilder().setName("enviar").setDescription("Envia um Pix pela Hydra Wallet").addStringOption(o=>o.setName("dados").setDescription("Chave e valor. Ex.: email@gmail.com 10").setRequired(true)).setIntegrationTypes(ApplicationIntegrationType.GuildInstall,ApplicationIntegrationType.UserInstall).setContexts(InteractionContextType.Guild,InteractionContextType.BotDM,InteractionContextType.PrivateChannel),
 async execute(interaction){ const partes=interaction.options.getString("dados",true).trim().split(/\s+/); if(partes.length<2) return interaction.reply({content:"Use: `/enviar dados: email@gmail.com 10`",flags:MessageFlags.Ephemeral}); const valor=converterValor(partes.pop()); await preparar(interaction,partes.join(""),valor); },
 criarModalEnviar, preparar
};
