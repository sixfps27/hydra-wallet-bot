require("dotenv").config();
const { definirSaldo } = require("./store");

const userId = process.argv[2];
if (!userId) {
  console.error("Uso: npm run reset:wallet -- SEU_ID_DO_DISCORD");
  process.exit(1);
}

const carteira = definirSaldo(userId, 0);
console.log(`✅ Carteira ${userId} zerada.`);
console.log(`Saldo: R$ ${carteira.saldo.toFixed(2)} | Reservado: R$ ${carteira.reservado.toFixed(2)}`);
