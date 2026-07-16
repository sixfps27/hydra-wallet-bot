const {
  ChannelType,
  PermissionFlagsBits
} = require("discord.js");

const {
  obterPerfilWallet,
  criarOuAtualizarPerfilWallet,
  atualizarCanalPrivadoPerfil
} = require("../store");

const MAIN_GUILD_ID = process.env.HYDRA_MAIN_GUILD_ID || "1524282646778085407";
const PRIVATE_CATEGORY_ID = process.env.HYDRA_PRIVATE_CATEGORY_ID || "1526865968222044180";
const ADMIN_ROLE_ID = process.env.HYDRA_ADMIN_ROLE_ID || "1526866107976126485";
const LOG_CHANNEL_ID = process.env.HYDRA_LOG_CHANNEL_ID || "1526866030255673434";

function limparNomeCanal(nome, userId) {
  const base = String(nome || "cliente")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "cliente";

  return `carteira-${base}-${String(userId).slice(-4)}`.slice(0, 100);
}

async function enviarLog(guild, mensagem) {
  try {
    const canal = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (canal?.isTextBased()) await canal.send({ content: mensagem });
  } catch (erro) {
    console.error("Erro ao enviar log de perfil:", erro.message);
  }
}

function permissoesDoCanal({ guild, member, adminRole, botMember }) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      // Usar o ID de um Member já buscado evita o erro
      // "Supplied parameter is not a cached User or Role".
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory
      ],
      deny: [PermissionFlagsBits.SendMessages]
    }
  ];

  // Só adiciona o cargo administrativo se ele realmente existir no servidor.
  if (adminRole) {
    overwrites.push({
      id: adminRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    });
  }

  // O bot também precisa estar resolvido como membro do servidor.
  if (botMember) {
    overwrites.push({
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels
      ]
    });
  }

  return overwrites;
}

async function garantirPerfilECanalPrivado({ client, user }) {
  if (!client || !user?.id) throw new Error("DADOS_DE_PERFIL_INVALIDOS");

  let perfil = criarOuAtualizarPerfilWallet({
    userId: user.id,
    username: user.username,
    displayName: user.globalName || user.username
  });

  const guild = await client.guilds.fetch(MAIN_GUILD_ID).catch(() => null);
  if (!guild) {
    console.warn(`Servidor principal ${MAIN_GUILD_ID} não encontrado.`);
    return { perfil, canal: null, criado: false, motivo: "GUILD_NAO_ENCONTRADA" };
  }

  if (perfil.privateChannelId) {
    const canalExistente = await guild.channels.fetch(perfil.privateChannelId).catch(() => null);
    if (canalExistente) return { perfil, canal: canalExistente, criado: false };
    atualizarCanalPrivadoPerfil(user.id, null);
    perfil = obterPerfilWallet(user.id);
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    console.warn(`Usuário ${user.id} não está no servidor principal; canal privado não criado.`);
    return { perfil, canal: null, criado: false, motivo: "USUARIO_FORA_DO_SERVIDOR" };
  }

  const topico = `hydra-wallet-user:${user.id}`;
  const canais = await guild.channels.fetch();
  const canalRecuperado = canais.find(
    canal => canal?.type === ChannelType.GuildText && canal.topic === topico
  );

  if (canalRecuperado) {
    perfil = atualizarCanalPrivadoPerfil(user.id, canalRecuperado.id);
    return { perfil, canal: canalRecuperado, criado: false, recuperado: true };
  }

  const categoria = await guild.channels.fetch(PRIVATE_CATEGORY_ID).catch(() => null);
  if (!categoria || categoria.type !== ChannelType.GuildCategory) {
    console.warn(`Categoria privada ${PRIVATE_CATEGORY_ID} não encontrada.`);
    return { perfil, canal: null, criado: false, motivo: "CATEGORIA_NAO_ENCONTRADA" };
  }

  // Busca explicitamente o cargo e o próprio bot antes de montar permissionOverwrites.
  const adminRole = await guild.roles.fetch(ADMIN_ROLE_ID).catch(() => null);
  const botMember = await guild.members.fetchMe().catch(() => null);

  if (!adminRole) {
    console.warn(`Cargo administrador ${ADMIN_ROLE_ID} não existe neste servidor. O canal será criado sem esse overwrite.`);
  }
  if (!botMember) throw new Error("BOT_NAO_ENCONTRADO_NO_SERVIDOR");

  const canal = await guild.channels.create({
    name: limparNomeCanal(user.globalName || user.username, user.id),
    type: ChannelType.GuildText,
    parent: categoria.id,
    topic: topico,
    reason: `Canal privado da Hydra Systems para ${user.tag || user.username}`,
    permissionOverwrites: permissoesDoCanal({ guild, member, adminRole, botMember })
  });

  perfil = atualizarCanalPrivadoPerfil(user.id, canal.id);

  await canal.send({
    content: [
      "# Hydra Systems",
      `Olá, <@${user.id}>. Este é o seu canal privado de comprovantes.`,
      "Somente você e a equipe autorizada da Hydra Systems podem visualizar este canal.",
      "Os comprovantes e movimentações da sua carteira serão enviados aqui."
    ].join("\n")
  });

  await enviarLog(guild, `✅ Canal privado criado para <@${user.id}>: <#${canal.id}>`);
  return { perfil, canal, criado: true };
}

module.exports = {
  garantirPerfilECanalPrivado,
  limparNomeCanal
};
