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
    if (canal?.isTextBased()) {
      await canal.send({ content: mensagem });
    }
  } catch (erro) {
    console.error("Erro ao enviar log de perfil:", erro.message);
  }
}

async function garantirPerfilECanalPrivado({ client, user }) {
  if (!client || !user?.id) {
    throw new Error("DADOS_DE_PERFIL_INVALIDOS");
  }

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

  // Se o perfil já tem canal salvo e ele ainda existe, reutiliza.
  if (perfil.privateChannelId) {
    const canalExistente = await guild.channels.fetch(perfil.privateChannelId).catch(() => null);
    if (canalExistente) {
      return { perfil, canal: canalExistente, criado: false };
    }

    // O canal foi apagado; limpa o vínculo e permite recriação.
    atualizarCanalPrivadoPerfil(user.id, null);
    perfil = obterPerfilWallet(user.id);
  }

  const membro = await guild.members.fetch(user.id).catch(() => null);
  if (!membro) {
    console.warn(`Usuário ${user.id} não está no servidor principal; canal privado não criado.`);
    return { perfil, canal: null, criado: false, motivo: "USUARIO_FORA_DO_SERVIDOR" };
  }

  // Proteção extra: procura um canal já criado para esse usuário, mesmo se o banco perdeu o vínculo.
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

  const nomeCanal = limparNomeCanal(user.globalName || user.username, user.id);

  const canal = await guild.channels.create({
    name: nomeCanal,
    type: ChannelType.GuildText,
    parent: PRIVATE_CATEGORY_ID,
    topic: topico,
    reason: `Canal privado da Hydra Systems para ${user.tag || user.username}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory
        ],
        deny: [PermissionFlagsBits.SendMessages]
      },
      {
        id: ADMIN_ROLE_ID,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages
        ]
      }
    ]
  });

  perfil = atualizarCanalPrivadoPerfil(user.id, canal.id);

  await canal.send({
    content: [
      `# Hydra Systems Wallet`,
      `Olá, <@${user.id}>. Este é o seu canal privado de comprovantes.`,
      `Somente você e a equipe autorizada da Hydra Wallet podem visualizar este canal.`,
      `Os comprovantes e movimentações da sua carteira serão enviados aqui nas próximas atualizações.`
    ].join("\n")
  });

  await enviarLog(
    guild,
    `✅ Canal privado criado para <@${user.id}>: <#${canal.id}>`
  );

  return { perfil, canal, criado: true };
}

module.exports = {
  garantirPerfilECanalPrivado,
  limparNomeCanal
};
