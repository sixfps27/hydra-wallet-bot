const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { obterPerfil, criarOuAtualizarPerfil, definirCanalPrivado } = require('../store');

function slug(texto) {
  return String(texto || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'cliente';
}

async function garantirPerfilECanal(interaction) {
  const user = interaction.user;
  let perfil = criarOuAtualizarPerfil(user.id, user.username);
  const guildId = process.env.HYDRA_MAIN_GUILD_ID;
  const categoryId = process.env.HYDRA_PRIVATE_CATEGORY_ID;
  const adminRoleId = process.env.HYDRA_ADMIN_ROLE_ID;
  if (!guildId || !categoryId || !adminRoleId) return perfil;

  const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return perfil;

  if (perfil.privateChannelId) {
    const existente = await guild.channels.fetch(perfil.privateChannelId).catch(() => null);
    if (existente) return perfil;
  }

  const channel = await guild.channels.create({
    name: `carteira-${slug(user.username)}-${user.id.slice(-4)}`,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: `Canal financeiro privado da Hydra Systems • Usuário ${user.id}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
    ]
  }).catch((erro) => {
    console.error('Não foi possível criar canal privado:', erro.message);
    return null;
  });

  if (channel) perfil = definirCanalPrivado(user.id, channel.id);
  return perfil;
}

async function enviarNoCanalPrivado(client, userId, payload) {
  const perfil = obterPerfil(userId);
  if (!perfil?.privateChannelId) return false;
  const channel = await client.channels.fetch(perfil.privateChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  await channel.send(payload);
  return true;
}

async function enviarLog(client, payload) {
  const channelId = process.env.HYDRA_LOG_CHANNEL_ID;
  if (!channelId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  await channel.send(payload).catch(() => {});
  return true;
}

module.exports = { garantirPerfilECanal, enviarNoCanalPrivado, enviarLog };
