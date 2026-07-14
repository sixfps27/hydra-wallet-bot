require("dotenv").config();

const { possuiCredenciais, listarPayouts } = require("./services/turbofyGateway");

(async () => {
  try {
    if (!possuiCredenciais()) {
      console.error("❌ TURBOFY_CLIENT_ID ou TURBOFY_CLIENT_SECRET não configurado no .env");
      process.exit(1);
    }

    console.log("🔄 Testando autenticação da Turbofy sem criar pagamentos...");
    const resposta = await listarPayouts();
    console.log("✅ Autenticação Turbofy funcionando!");
    console.log(`📦 Lotes encontrados: ${Array.isArray(resposta?.items) ? resposta.items.length : Array.isArray(resposta?.batches) ? resposta.batches.length : 0}`);
  } catch (erro) {
    console.error("❌ Falha no teste da Turbofy");
    console.error(`Código: ${erro.code || "DESCONHECIDO"}`);
    console.error(`Mensagem: ${erro.message}`);
    if (erro.status) console.error(`HTTP: ${erro.status}`);
    process.exit(1);
  }
})();
