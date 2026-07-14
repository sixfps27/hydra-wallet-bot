function normalizarChavePix(chave) {
  return String(chave ?? "").trim();
}

function descobrirTipoChavePix(chave) {
  const limpa = normalizarChavePix(chave);
  if (limpa.includes("@")) return "EMAIL";
  if (limpa.startsWith("+")) return "PHONE";
  const numeros = limpa.replace(/\D/g, "");
  if (numeros.length === 14) return "CNPJ";
  if (numeros.length === 11) return "CPF";
  if (numeros.length === 10) return "PHONE";
  return "EVP";
}

function mascararChave(chave) {
  const limpa = normalizarChavePix(chave);
  if (limpa.length <= 8) return `${limpa.slice(0, 2)}***`;
  return `${limpa.slice(0, 4)}...${limpa.slice(-4)}`;
}

function chavePixValida(chave) {
  return normalizarChavePix(chave).length >= 3;
}

module.exports = { normalizarChavePix, descobrirTipoChavePix, mascararChave, chavePixValida };
