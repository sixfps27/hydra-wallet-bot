const COLORS = {
  primary: "#0B1F3A",
  accent: "#2563EB",
  success: "#22C55E",
  warning: "#F59E0B",
  danger: "#EF4444",
  neutral: "#64748B"
};

const BRAND = "Hydra Systems";
const FOOTER = "Hydra Systems • Sistema financeiro";

function cabecalho(titulo, subtitulo) {
  return [`## ${titulo}`, subtitulo ? `*${subtitulo}*` : null].filter(Boolean).join("\n");
}

module.exports = { COLORS, BRAND, FOOTER, cabecalho };
