const { normalizarChavePix } = require("./pix");

function limparCandidato(valor) {
  return normalizarChavePix(valor)
    .replace(/^[`'"“”‘’<({\[]+/, "")
    .replace(/[`'"“”‘’>)}\],;.!?]+$/, "");
}

function extrairChavePixDaMensagem(conteudo) {
  const texto = String(conteudo || "").trim();
  if (!texto) return null;

  const email = texto.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email) return limparCandidato(email);

  const evp = texto.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i)?.[0];
  if (evp) return limparCandidato(evp);

  const telefone = texto.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-.\s]?\d{4}/)?.[0];
  if (telefone) {
    const original = limparCandidato(telefone);
    const numeros = original.replace(/\D/g, "");
    if (numeros.length >= 10 && numeros.length <= 13) {
      return original.startsWith("+") ? original : numeros;
    }
  }

  const documento = texto.match(/\b(?:\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-.\s]?\d{2}|\d{2}[.\s-]?\d{3}[.\s-]?\d{3}[\/.\s-]?\d{4}[-.\s]?\d{2})\b/)?.[0];
  if (documento) return documento.replace(/\D/g, "");

  // Quando a mensagem contém somente a chave, aceita um token único como fallback.
  const tokenUnico = texto.split(/\s+/).length === 1 ? limparCandidato(texto) : null;
  if (tokenUnico && tokenUnico.length >= 8 && tokenUnico.length <= 100) return tokenUnico;

  return null;
}

module.exports = { extrairChavePixDaMensagem };
