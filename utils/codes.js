const crypto = require("crypto");

function gerarCodigoHydra() {
  return `HDW-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function gerarIdCurto(tamanho = 12) {
  return crypto.randomUUID().replaceAll("-", "").slice(0, tamanho);
}

module.exports = { gerarCodigoHydra, gerarIdCurto };
