require("dotenv").config();

const { REST, Routes } = require("discord.js");

const carteiraCommand = require("./commands/carteira");
const enviarCommand = require("./commands/enviar");

if (!process.env.TOKEN) {
  console.error("❌ TOKEN não encontrado no arquivo .env");
  process.exit(1);
}

if (!process.env.CLIENT_ID) {
  console.error("❌ CLIENT_ID não encontrado no arquivo .env");
  process.exit(1);
}

const commands = [
  carteiraCommand.data.toJSON(),
  enviarCommand.data.toJSON()
];

const rest = new REST({
  version: "10"
}).setToken(process.env.TOKEN);

async function registrarComandos() {
  try {
    console.log("🔄 Registrando comandos globais...");

    const resultado = await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      {
        body: commands
      }
    );

    console.log(`✅ ${resultado.length} comandos registrados!`);

    for (const comando of resultado) {
      console.log(`➡️ /${comando.name}`);
    }
  } catch (error) {
    console.error("❌ Erro ao registrar os comandos:");
    console.error(error);
  }
}

registrarComandos();