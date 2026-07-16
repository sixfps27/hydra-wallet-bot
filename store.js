const Database = require("better-sqlite3");
const { gerarIdCurto, gerarCodigoHydra } = require("./utils/codes");
const { paraCentavos, paraReais } = require("./utils/money");

const db = new Database("hydra-wallet.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pix_key TEXT NOT NULL,
  recipient_name TEXT NOT NULL DEFAULT 'Destinatário',
  recipient_document TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  hydra_code TEXT,
  gateway_batch_id TEXT,
  gateway_status TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gateway_id TEXT NOT NULL UNIQUE,
  gross_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  copy_paste TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  credited_at INTEGER
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS action_cooldowns (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (user_id, action)
);
CREATE TABLE IF NOT EXISTS wallet_profiles (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  private_channel_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

function adicionarColunaSeFaltar(tabela, coluna, definicao) {
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all().map(c => c.name);
  if (!colunas.includes(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
}
adicionarColunaSeFaltar("payments", "recipient_document", "TEXT");
adicionarColunaSeFaltar("payments", "hydra_code", "TEXT");
adicionarColunaSeFaltar("payments", "gateway_batch_id", "TEXT");
adicionarColunaSeFaltar("payments", "gateway_status", "TEXT");
adicionarColunaSeFaltar("payments", "gateway_payout_id", "TEXT");
adicionarColunaSeFaltar("payments", "end_to_end_id", "TEXT");
adicionarColunaSeFaltar("payments", "provider_transaction_id", "TEXT");
adicionarColunaSeFaltar("payments", "provider_charge_id", "TEXT");
adicionarColunaSeFaltar("payments", "pix_txid", "TEXT");
adicionarColunaSeFaltar("payments", "external_ref", "TEXT");
adicionarColunaSeFaltar("payments", "receipt_sent_at", "INTEGER");
adicionarColunaSeFaltar("payments", "receipt_claimed_at", "INTEGER");
adicionarColunaSeFaltar("payments", "idempotency_key", "TEXT");
adicionarColunaSeFaltar("payments", "retry_count", "INTEGER NOT NULL DEFAULT 0");
adicionarColunaSeFaltar("payments", "retry_after", "INTEGER");
adicionarColunaSeFaltar("payments", "analysis_notified_at", "INTEGER");
adicionarColunaSeFaltar("deposits", "provider_fee_cents", "INTEGER NOT NULL DEFAULT 0");
adicionarColunaSeFaltar("deposits", "admin_fee_cents", "INTEGER NOT NULL DEFAULT 0");

function garantirCarteira(userId) {
  const agora = Date.now();
  db.prepare(`INSERT OR IGNORE INTO wallets(user_id,balance_cents,reserved_cents,created_at,updated_at) VALUES(?,0,0,?,?)`).run(userId, agora, agora);
}

function obterCarteira(userId) {
  garantirCarteira(userId);
  const w = db.prepare(`SELECT balance_cents,reserved_cents FROM wallets WHERE user_id=?`).get(userId);
  const extrato = db.prepare(`SELECT type AS tipo, amount_cents, description AS nome, reference_id AS id, created_at AS criadoEm FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20`).all(userId);
  return { saldo: paraReais(w.balance_cents), reservado: paraReais(w.reserved_cents), extrato: extrato.map(x => ({...x, valor: paraReais(x.amount_cents)})) };
}

function criarOuAtualizarPerfilWallet({ userId, username, displayName }) {
  const agora = Date.now();
  garantirCarteira(userId);
  db.prepare(`
    INSERT INTO wallet_profiles(user_id, username, display_name, status, private_channel_id, created_at, updated_at)
    VALUES(?,?,?,'active',NULL,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      username=excluded.username,
      display_name=excluded.display_name,
      updated_at=excluded.updated_at
  `).run(userId, username || "usuario", displayName || username || "Usuário", agora, agora);
  return obterPerfilWallet(userId);
}

function obterPerfilWallet(userId) {
  const perfil = db.prepare(`SELECT * FROM wallet_profiles WHERE user_id=?`).get(userId);
  if (!perfil) return null;
  return {
    userId: perfil.user_id,
    username: perfil.username,
    displayName: perfil.display_name,
    status: perfil.status,
    privateChannelId: perfil.private_channel_id,
    createdAt: perfil.created_at,
    updatedAt: perfil.updated_at
  };
}

function atualizarCanalPrivadoPerfil(userId, channelId) {
  const agora = Date.now();
  db.prepare(`UPDATE wallet_profiles SET private_channel_id=?, updated_at=? WHERE user_id=?`)
    .run(channelId || null, agora, userId);
  return obterPerfilWallet(userId);
}

function adicionarSaldo(userId, valor, descricao="Crédito") {
  garantirCarteira(userId);
  const cents = paraCentavos(valor), agora = Date.now(), ref = gerarIdCurto();
  db.transaction(() => {
    db.prepare(`UPDATE wallets SET balance_cents=balance_cents+?,updated_at=? WHERE user_id=?`).run(cents, agora, userId);
    db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`).run(userId,"credito",cents,descricao,ref,agora);
  })();
  return obterCarteira(userId);
}

function criarPagamento({ usuarioId, chave, valor, nomeDestinatario="Destinatário", documentoDestinatario=null }) {
  garantirCarteira(usuarioId);
  const id = gerarIdCurto();
  db.prepare(`INSERT INTO payments(id,user_id,pix_key,recipient_name,recipient_document,amount_cents,status,hydra_code,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, usuarioId, chave, nomeDestinatario, documentoDestinatario, paraCentavos(valor), "aguardando_confirmacao", gerarCodigoHydra(), Date.now());
  return obterPagamento(id);
}

function obterPagamento(id) {
  const p = db.prepare(`SELECT * FROM payments WHERE id=?`).get(id);
  if (!p) return null;
  return { id:p.id, usuarioId:p.user_id, chave:p.pix_key, nomeDestinatario:p.recipient_name, documentoDestinatario:p.recipient_document, valor:paraReais(p.amount_cents), status:p.status, codigoHydra:p.hydra_code, batchId:p.gateway_batch_id, gatewayStatus:p.gateway_status, payoutId:p.gateway_payout_id, endToEndId:p.end_to_end_id, providerTransactionId:p.provider_transaction_id, providerChargeId:p.provider_charge_id, pixTxid:p.pix_txid, externalRef:p.external_ref, criadoEm:p.created_at, concluidoEm:p.completed_at, comprovanteEnviadoEm:p.receipt_sent_at, comprovanteEmProcessamentoEm:p.receipt_claimed_at, idempotencyKey:p.idempotency_key, retryCount:Number(p.retry_count||0), retryAfter:p.retry_after, analiseAvisadaEm:p.analysis_notified_at };
}

function atualizarPagamento(id, campos={}) {
  const permitidos = { status:"status", batchId:"gateway_batch_id", gatewayStatus:"gateway_status", payoutId:"gateway_payout_id", endToEndId:"end_to_end_id", providerTransactionId:"provider_transaction_id", providerChargeId:"provider_charge_id", pixTxid:"pix_txid", externalRef:"external_ref", concluidoEm:"completed_at", nomeDestinatario:"recipient_name", documentoDestinatario:"recipient_document", idempotencyKey:"idempotency_key", retryCount:"retry_count", retryAfter:"retry_after", analiseAvisadaEm:"analysis_notified_at" };
  const sets=[], vals=[];
  for (const [k,v] of Object.entries(campos)) if (permitidos[k]) { sets.push(`${permitidos[k]}=?`); vals.push(v); }
  if (sets.length) db.prepare(`UPDATE payments SET ${sets.join(",")} WHERE id=?`).run(...vals,id);
  return obterPagamento(id);
}

function reservarSaldo(pagamento) {
  const cents=paraCentavos(pagamento.valor), agora=Date.now();
  db.transaction(() => {
    const w=db.prepare(`SELECT balance_cents FROM wallets WHERE user_id=?`).get(pagamento.usuarioId);
    if (!w || w.balance_cents<cents) throw new Error("SALDO_INSUFICIENTE");
    db.prepare(`UPDATE wallets SET balance_cents=balance_cents-?,reserved_cents=reserved_cents+?,updated_at=? WHERE user_id=?`).run(cents,cents,agora,pagamento.usuarioId);
    db.prepare(`UPDATE payments SET status='processando' WHERE id=?`).run(pagamento.id);
  })();
}

function concluirPagamento(pagamento, batchId, gatewayStatus="paid") {
  const cents = paraCentavos(pagamento.valor);
  const agora = Date.now();

  db.transaction(() => {
    const atual = db.prepare(`SELECT status FROM payments WHERE id=?`).get(pagamento.id);
    if (!atual || atual.status === "concluido") return;
    if (atual.status !== "processando") {
      throw new Error(`PAGAMENTO_NAO_PROCESSANDO:${atual.status}`);
    }

    db.prepare(`UPDATE wallets SET reserved_cents=MAX(0,reserved_cents-?),updated_at=? WHERE user_id=?`)
      .run(cents, agora, pagamento.usuarioId);
    db.prepare(`UPDATE payments SET status='concluido',gateway_batch_id=?,gateway_status=?,completed_at=? WHERE id=?`)
      .run(batchId, gatewayStatus, agora, pagamento.id);
    db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(pagamento.usuarioId, "pix_enviado", cents, pagamento.chave, pagamento.id, agora);
  })();

  return obterPagamento(pagamento.id);
}

function falharPagamento(pagamento, gatewayStatus="failed") {
  const cents = paraCentavos(pagamento.valor);
  const agora = Date.now();

  db.transaction(() => {
    const atual = db.prepare(`SELECT status FROM payments WHERE id=?`).get(pagamento.id);
    if (!atual || atual.status === "falhou") return;
    if (atual.status !== "processando") {
      throw new Error(`PAGAMENTO_NAO_PROCESSANDO:${atual.status}`);
    }

    db.prepare(`UPDATE wallets SET balance_cents=balance_cents+?,reserved_cents=MAX(0,reserved_cents-?),updated_at=? WHERE user_id=?`)
      .run(cents, cents, agora, pagamento.usuarioId);
    db.prepare(`UPDATE payments SET status='falhou',gateway_status=? WHERE id=?`)
      .run(gatewayStatus, pagamento.id);
  })();

  return obterPagamento(pagamento.id);
}



function corrigirPagamentoConcluidoAposEstorno(pagamento, batchId, gatewayStatus="paid") {
  const cents = paraCentavos(pagamento.valor);
  const agora = Date.now();

  db.transaction(() => {
    const atual = db.prepare(`SELECT status FROM payments WHERE id=?`).get(pagamento.id);
    if (!atual || atual.status === "concluido") return;
    if (atual.status !== "falhou") {
      throw new Error(`PAGAMENTO_NAO_ESTORNADO:${atual.status}`);
    }

    // A versão anterior devolvia o saldo antes da confirmação final da Turbofy.
    // Se a API confirmar que o Pix foi pago, removemos novamente o valor disponível.
    db.prepare(`UPDATE wallets SET balance_cents=balance_cents-?,updated_at=? WHERE user_id=?`)
      .run(cents, agora, pagamento.usuarioId);
    db.prepare(`UPDATE payments SET status='concluido',gateway_batch_id=?,gateway_status=?,completed_at=? WHERE id=?`)
      .run(batchId, gatewayStatus, agora, pagamento.id);
    db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(pagamento.usuarioId, "pix_enviado", cents, pagamento.chave, pagamento.id, agora);
  })();

  return obterPagamento(pagamento.id);
}

function reivindicarEnvioComprovante(paymentId, validadeMs = 5 * 60 * 1000) {
  const agora = Date.now();
  const limite = agora - validadeMs;
  const resultado = db.prepare(`
    UPDATE payments
    SET receipt_claimed_at=?
    WHERE id=?
      AND receipt_sent_at IS NULL
      AND (receipt_claimed_at IS NULL OR receipt_claimed_at < ?)
  `).run(agora, paymentId, limite);
  return resultado.changes > 0;
}

function marcarComprovanteEnviado(paymentId) {
  const agora = Date.now();
  const resultado = db.prepare(`
    UPDATE payments
    SET receipt_sent_at=?, receipt_claimed_at=NULL
    WHERE id=? AND receipt_sent_at IS NULL
  `).run(agora, paymentId);
  return resultado.changes > 0;
}

function liberarComprovanteParaReenvio(paymentId) {
  db.prepare(`UPDATE payments SET receipt_sent_at=NULL, receipt_claimed_at=NULL WHERE id=?`).run(paymentId);
  return obterPagamento(paymentId);
}

function liberarReivindicacaoComprovante(paymentId) {
  db.prepare(`UPDATE payments SET receipt_claimed_at=NULL WHERE id=? AND receipt_sent_at IS NULL`).run(paymentId);
}

function obterPagamentoAtivoPorUsuarioChave(userId, chave, excluirId = null) {
  const limiteConfirmacao = Date.now() - 10 * 60 * 1000;
  const sql = `SELECT id FROM payments
    WHERE user_id=? AND pix_key=?
      AND (status='processando' OR (status='aguardando_confirmacao' AND created_at>=?))
      AND (? IS NULL OR id<>?)
    ORDER BY created_at DESC LIMIT 1`;
  const row = db.prepare(sql).get(userId, chave, limiteConfirmacao, excluirId, excluirId);
  return row ? obterPagamento(row.id) : null;
}


function listarPagamentosReconciliaveis(limite = 8) {
  const maximo = Math.max(1, Math.min(50, Number(limite) || 8));
  const agora = Date.now();
  const processandoDesde = agora - Math.max(30 * 60 * 1000, Number(process.env.PAYOUT_RECONCILE_MAX_AGE_MS || 24 * 60 * 60 * 1000));
  const falhouDesde = agora - Math.max(5 * 60 * 1000, Number(process.env.PAYOUT_LATE_SUCCESS_WINDOW_MS || 30 * 60 * 1000));

  // Novos pagamentos têm prioridade. Pagamentos falhos só são revisitados por uma janela curta
  // para capturar confirmações tardias, evitando consultar o histórico inteiro para sempre.
  return db.prepare(`
    SELECT id
    FROM payments
    WHERE gateway_batch_id IS NOT NULL
      AND (
        (status='processando' AND created_at>=?)
        OR
        (status='falhou' AND created_at>=?)
      )
    ORDER BY
      CASE WHEN status='processando' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT ?
  `).all(processandoDesde, falhouDesde, maximo).map(({ id }) => obterPagamento(id));
}

function criarDeposito({
  id, usuarioId, gatewayId, valorBruto, taxa, taxaProvedor = 0, taxaAdmin = 0,
  valorLiquido, copiaECola, expiraEm
}) {
  garantirCarteira(usuarioId);
  db.prepare(`
    INSERT INTO deposits(
      id,user_id,gateway_id,gross_cents,fee_cents,provider_fee_cents,
      admin_fee_cents,net_cents,status,copy_paste,expires_at,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, usuarioId, gatewayId, paraCentavos(valorBruto), paraCentavos(taxa),
    paraCentavos(taxaProvedor), paraCentavos(taxaAdmin), paraCentavos(valorLiquido),
    "pending", copiaECola || null, expiraEm || null, Date.now()
  );
  return obterDeposito(id);
}

function obterDeposito(id) {
  const d = db.prepare(`SELECT * FROM deposits WHERE id=? OR gateway_id=?`).get(id, id);
  if (!d) return null;
  return {
    id: d.id, usuarioId: d.user_id, gatewayId: d.gateway_id,
    valorBruto: paraReais(d.gross_cents),
    taxa: paraReais(d.fee_cents),
    taxaProvedor: paraReais(d.provider_fee_cents || 0),
    taxaAdmin: paraReais(d.admin_fee_cents || 0),
    valorLiquido: paraReais(d.net_cents),
    status: d.status, copiaECola: d.copy_paste, expiraEm: d.expires_at, criadoEm: d.created_at,
    pagoEm: d.paid_at, creditadoEm: d.credited_at
  };
}

function marcarDepositoPago(id, status="paid") {
  const deposito = obterDeposito(id);
  if (!deposito) throw new Error("DEPOSITO_NAO_ENCONTRADO");

  const adminUserId = String(process.env.HYDRA_ADMIN_WALLET_USER_ID || "").trim();
  const agora = Date.now();

  db.transaction(() => {
    const atual = db.prepare(`SELECT credited_at FROM deposits WHERE id=?`).get(deposito.id);
    if (!atual || atual.credited_at) return;

    const liquidoCents = paraCentavos(deposito.valorLiquido);
    const taxaAdminCents = paraCentavos(deposito.taxaAdmin || 0);

    garantirCarteira(deposito.usuarioId);
    db.prepare(`UPDATE wallets SET balance_cents=balance_cents+?,updated_at=? WHERE user_id=?`)
      .run(liquidoCents, agora, deposito.usuarioId);
    db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(
        deposito.usuarioId,
        "deposito",
        liquidoCents,
        `Depósito Pix (bruto R$ ${deposito.valorBruto.toFixed(2)}; taxa total R$ ${deposito.taxa.toFixed(2)})`,
        deposito.id,
        agora
      );

    if (taxaAdminCents > 0 && adminUserId) {
      garantirCarteira(adminUserId);
      db.prepare(`UPDATE wallets SET balance_cents=balance_cents+?,updated_at=? WHERE user_id=?`)
        .run(taxaAdminCents, agora, adminUserId);
      db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`)
        .run(
          adminUserId,
          "taxa_deposito",
          taxaAdminCents,
          `Taxa Hydra Systems do depósito do usuário ${deposito.usuarioId}`,
          deposito.id,
          agora
        );
    }

    db.prepare(`UPDATE deposits SET status=?,paid_at=?,credited_at=? WHERE id=?`)
      .run(status, agora, agora, deposito.id);
  })();

  return obterDeposito(deposito.id);
}

function atualizarStatusDeposito(id, status) {
  const deposito = obterDeposito(id);
  if (!deposito) return null;
  db.prepare(`UPDATE deposits SET status=? WHERE id=?`).run(status, deposito.id);
  return obterDeposito(deposito.id);
}

function definirCooldown(userId, action = "pix_send", duracaoMs = 60000, motivo = "payment_error") {
  const expiraEm = Date.now() + Math.max(1000, Number(duracaoMs) || 60000);
  db.prepare(`
    INSERT INTO action_cooldowns(user_id, action, expires_at, reason)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id, action) DO UPDATE SET
      expires_at=excluded.expires_at,
      reason=excluded.reason
  `).run(userId, action, expiraEm, motivo);
  return { ativo: true, expiraEm, restanteMs: Math.max(0, expiraEm - Date.now()), motivo };
}

function obterCooldown(userId, action = "pix_send") {
  const registro = db.prepare(`SELECT expires_at, reason FROM action_cooldowns WHERE user_id=? AND action=?`).get(userId, action);
  if (!registro) return { ativo: false, restanteMs: 0, expiraEm: null, motivo: null };
  const restanteMs = Number(registro.expires_at) - Date.now();
  if (restanteMs <= 0) {
    db.prepare(`DELETE FROM action_cooldowns WHERE user_id=? AND action=?`).run(userId, action);
    return { ativo: false, restanteMs: 0, expiraEm: null, motivo: null };
  }
  return { ativo: true, restanteMs, expiraEm: Number(registro.expires_at), motivo: registro.reason || null };
}

function limparCooldown(userId, action = "pix_send") {
  db.prepare(`DELETE FROM action_cooldowns WHERE user_id=? AND action=?`).run(userId, action);
}

function definirSaldo(userId, valor=0) {
  garantirCarteira(userId);
  db.prepare(`UPDATE wallets SET balance_cents=?, reserved_cents=0, updated_at=? WHERE user_id=?`)
    .run(paraCentavos(valor), Date.now(), userId);
  return obterCarteira(userId);
}

module.exports = {
  obterCarteira,
  criarOuAtualizarPerfilWallet,
  obterPerfilWallet,
  atualizarCanalPrivadoPerfil,
  adicionarSaldo,
  definirSaldo,
  criarPagamento,
  obterPagamento,
  atualizarPagamento,
  reservarSaldo,
  concluirPagamento,
  falharPagamento,
  corrigirPagamentoConcluidoAposEstorno,
  listarPagamentosReconciliaveis,
  criarDeposito,
  obterDeposito,
  marcarDepositoPago,
  atualizarStatusDeposito,
  definirCooldown,
  obterCooldown,
  limparCooldown,
  reivindicarEnvioComprovante,
  marcarComprovanteEnviado,
  liberarComprovanteParaReenvio,
  liberarReivindicacaoComprovante,
  obterPagamentoAtivoPorUsuarioChave
};
