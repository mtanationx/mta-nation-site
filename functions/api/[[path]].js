import LOG_SEED from "../_lib/seed-logistics.js";
import GIVING_SEED from "../_lib/seed-giving.js";
// MTA Nation POS — API (Cloudflare Pages Functions + D1, binding "DB")
// Rotas em /api/*. Ver docs/POS.md.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pin_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'seller', commission REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_fail(ip TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS stock(product_id TEXT NOT NULL, cor TEXT NOT NULL, size TEXT NOT NULL, qty INTEGER, PRIMARY KEY(product_id,cor,size))`,
  `CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, ts INTEGER NOT NULL, user_id INTEGER NOT NULL, channel TEXT, payment TEXT, delivery INTEGER NOT NULL DEFAULT 0, subtotal INTEGER NOT NULL DEFAULT 0, customer TEXT, phone TEXT, notes TEXT, void INTEGER NOT NULL DEFAULT 0, void_by INTEGER, void_reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS sales_day ON sales(day)`,
  `CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, product_id TEXT NOT NULL, name TEXT, cor TEXT, size TEXT, qty INTEGER NOT NULL, unit_price INTEGER NOT NULL, list_price INTEGER)`,
  `CREATE INDEX IF NOT EXISTS items_sale ON sale_items(sale_id)`,
  `CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, type TEXT, amount INTEGER NOT NULL, notes TEXT, user_id INTEGER, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS stock_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, user_id INTEGER, product_id TEXT, cor TEXT, size TEXT, before INTEGER, after INTEGER, reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT UNIQUE, birthday TEXT, ring_size TEXT, wrist_size TEXT, instagram TEXT, source TEXT, notes TEXT, created TEXT, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT, start TEXT, end TEXT, cost INTEGER NOT NULL DEFAULT 0, message TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS campaign_sends(campaign_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, ts INTEGER, user_id INTEGER, PRIMARY KEY(campaign_id,customer_id))`,
  `CREATE TABLE IF NOT EXISTS giving(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, description TEXT, category TEXT, amount INTEGER NOT NULL, method TEXT, paid_by TEXT, notes TEXT, recurring INTEGER NOT NULL DEFAULT 0, has_receipt INTEGER NOT NULL DEFAULT 0, user_id INTEGER, ts INTEGER)`,
  `CREATE INDEX IF NOT EXISTS giving_day ON giving(day)`,
  `CREATE TABLE IF NOT EXISTS receipts(giving_id INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS logistics(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, order_day TEXT, arrival_day TEXT, status TEXT, via TEXT, usd REAL, mzn INTEGER, pickup INTEGER, supplier TEXT, brand TEXT, tracking TEXT, notes TEXT, has_file INTEGER NOT NULL DEFAULT 0, user_id INTEGER, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS logistics_files(log_id INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS devices(token TEXT PRIMARY KEY, name TEXT, active INTEGER NOT NULL DEFAULT 1, created INTEGER, user_id INTEGER)`,
  `CREATE TABLE IF NOT EXISTS schedules(user_id INTEGER NOT NULL, dow INTEGER NOT NULL, start TEXT, end TEXT, PRIMARY KEY(user_id,dow))`,
  `CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, day TEXT NOT NULL, in_ts INTEGER, out_ts INTEGER, edited_by INTEGER, note TEXT)`,
  `CREATE INDEX IF NOT EXISTS shifts_day ON shifts(day)`,
  `CREATE TABLE IF NOT EXISTS cash_moves(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT, type TEXT NOT NULL, amount INTEGER NOT NULL, counted INTEGER, expected INTEGER, user_id INTEGER, notes TEXT)`,
];
let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  for (const q of [`ALTER TABLE expenses ADD COLUMN paid_cash INTEGER NOT NULL DEFAULT 1`, `ALTER TABLE sales ADD COLUMN customer_id INTEGER`, `ALTER TABLE sales ADD COLUMN campaign_id INTEGER`, `ALTER TABLE sales ADD COLUMN source TEXT`, `ALTER TABLE logistics ADD COLUMN pay_method TEXT`, `ALTER TABLE logistics ADD COLUMN pickup_method TEXT`, `ALTER TABLE giving ADD COLUMN status TEXT NOT NULL DEFAULT 'Pago'`, `ALTER TABLE users ADD COLUMN ot_rate INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE sales ADD COLUMN discount INTEGER NOT NULL DEFAULT 0`]) { try { await db.prepare(q).run(); } catch (e) { /* já existe */ } }
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS sales_cust ON sales(customer_id)`).run(); } catch (e) {}
  ready = true;
}

const SALT = "mta-pos-v1";
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT + s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const json = (d, status = 200, h = {}) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });
const err = (msg, status = 400) => json({ error: msg }, status);
// Data de Maputo (UTC+2)
const today = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
// Telefone normalizado: só dígitos; 9 dígitos a começar por 8 → +258
function normPhone(p) {
  const t = String(p || "").trim(); let d = t.replace(/\D/g, ""); if (!d) return "";
  if (t.startsWith("00")) d = d.slice(2);
  if (d.startsWith("258")) return d.length === 12 && /^2588[2-7]/.test(d) ? d : "";
  if (/^(\+|00)/.test(t)) return d.length >= 8 && d.length <= 15 ? d : "";
  return d.length === 9 && /^8[2-7]/.test(d) ? "258" + d : "";
}
async function upsertCustomer(db, { name, phone, source }) {
  const ph = normPhone(phone); if (!ph) return null;
  const ex = await db.prepare(`SELECT id,name FROM customers WHERE phone=?`).bind(ph).first();
  if (ex) { if (!ex.name && name) await db.prepare(`UPDATE customers SET name=?, updated=? WHERE id=?`).bind(name, Date.now(), ex.id).run(); return ex.id; }
  const r = await db.prepare(`INSERT INTO customers(name,phone,source,created,updated) VALUES(?,?,?,?,?)`).bind(name || "", ph, source || "", today(), Date.now()).run();
  return r.meta.last_row_id;
}
const CUST_STATS = `SELECT c.*, COUNT(s.id) n, COALESCE(SUM(s.subtotal),0) total, MAX(s.ts) last FROM customers c LEFT JOIN sales s ON s.customer_id=c.id AND s.void=0`;
// Hora de Maputo
const mzDay = ts => new Date(ts + 2 * 3600e3).toISOString().slice(0, 10);
const mzMin = ts => { const d = new Date(ts + 2 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hm2min = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
const COR_LABEL = { ouro: "Dourado", prata: "Prateado", "-": "—" };

async function auth(req, db) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  const u = await db.prepare(`SELECT u.id,u.name,u.role,u.commission FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1`).bind(t, Date.now()).first();
  return u || null;
}

async function saleDetail(db, where, binds) {
  const sales = (await db.prepare(`SELECT s.*, u.name AS seller FROM sales s JOIN users u ON u.id=s.user_id WHERE ${where} ORDER BY s.id`).bind(...binds).all()).results;
  if (!sales.length) return [];
  const ids = sales.map(s => s.id);
  const items = (await db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all()).results;
  sales.forEach(s => s.items = items.filter(i => i.sale_id === s.id));
  return sales;
}

async function adjustStock(db, user, rows, reason) {
  // rows: [{product_id,cor,size,delta}] — só mexe em linhas que existem e têm número
  const out = [];
  for (const r of rows) {
    const cur = await db.prepare(`SELECT qty FROM stock WHERE product_id=? AND cor=? AND size=?`).bind(r.product_id, r.cor, r.size).first();
    if (!cur || cur.qty == null) continue;
    const after = Math.max(0, cur.qty + r.delta);
    out.push(db.prepare(`UPDATE stock SET qty=? WHERE product_id=? AND cor=? AND size=?`).bind(after, r.product_id, r.cor, r.size));
    out.push(db.prepare(`INSERT INTO stock_log(ts,user_id,product_id,cor,size,before,after,reason) VALUES(?,?,?,?,?,?,?,?)`).bind(Date.now(), user.id, r.product_id, r.cor, r.size, cur.qty, after, reason));
  }
  if (out.length) await db.batch(out);
}

function parseCSV(t) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; } else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const csvCell = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const db = env.DB;
  if (!db) return err("Base de dados não ligada (binding DB em falta)", 500);
  await init(db);
  const path = "/" + (params.path || []).join("/");
  const m = req.method;
  const url = new URL(req.url);
  let body = {};
  if (m !== "GET" && m !== "HEAD") { try { body = await req.json(); } catch (e) { body = {}; } }

  // ---------- Público ----------
  if (path === "/stock" && m === "GET") {
    // Mesmo formato da Google Sheet: Categoria,Produto,Cor,Tamanho,Stock,ID
    const rows = (await db.prepare(`SELECT * FROM stock ORDER BY product_id,cor,size`).all()).results;
    const csv = ["Categoria,Produto,Cor,Tamanho,Stock,ID"].concat(rows.map(r => ["", "", COR_LABEL[r.cor] || r.cor, r.size === "-" ? "—" : r.size, r.qty == null ? "" : r.qty, r.product_id].map(csvCell).join(","))).join("\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "public, max-age=30" } });
  }
  if (path === "/status" && m === "GET") {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    return json({ ok: true, setup: n.n === 0 });
  }
  if (path === "/setup" && m === "POST") {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    if (n.n > 0) return err("Já configurado", 403);
    const name = String(body.name || "").trim(), pin = String(body.pin || "");
    if (!name || !/^\d{4,8}$/.test(pin)) return err("Nome e PIN (4–8 dígitos) obrigatórios");
    await db.prepare(`INSERT INTO users(name,pin_hash,role,commission,created) VALUES(?,?, 'admin', 0, ?)`).bind(name, await sha(pin), today()).run();
    return json({ ok: true });
  }
  if (path === "/login" && m === "POST") {
    const ip = req.headers.get("cf-connecting-ip") || "x";
    const since = Date.now() - 15 * 60e3;
    const fails = await db.prepare(`SELECT COUNT(*) AS n FROM login_fail WHERE ip=? AND ts>?`).bind(ip, since).first();
    if (fails.n >= 10) return err("Demasiadas tentativas. Espera 15 minutos.", 429);
    const pin = String(body.pin || "");
    const u = await db.prepare(`SELECT id,name,role,commission FROM users WHERE pin_hash=? AND active=1`).bind(await sha(pin)).first();
    if (!u) { await db.prepare(`INSERT INTO login_fail(ip,ts) VALUES(?,?)`).bind(ip, Date.now()).run(); return err("PIN incorreto", 401); }
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, "0")).join("");
    await db.batch([
      db.prepare(`INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)`).bind(token, u.id, Date.now() + 14 * 3600e3),
      db.prepare(`DELETE FROM sessions WHERE expires<?`).bind(Date.now()),
      db.prepare(`DELETE FROM login_fail WHERE ts<?`).bind(since),
    ]);
    return json({ token, user: u });
  }

  // Ponto (clock in/out) — só a partir do dispositivo da loja
  if (path === "/clock" && m === "POST") {
    const dev = await db.prepare(`SELECT token,name FROM devices WHERE token=? AND active=1`).bind(String(body.device || "")).first();
    if (!dev) return err("Este dispositivo não está autorizado a marcar ponto. Usa o tablet da loja.", 403);
    const ip = req.headers.get("cf-connecting-ip") || "x", since = Date.now() - 15 * 60e3;
    const fails = await db.prepare(`SELECT COUNT(*) AS n FROM login_fail WHERE ip=? AND ts>?`).bind(ip, since).first();
    if (fails.n >= 10) return err("Demasiadas tentativas. Espera 15 minutos.", 429);
    const u = await db.prepare(`SELECT id,name FROM users WHERE pin_hash=? AND active=1`).bind(await sha(String(body.pin || ""))).first();
    if (!u) { await db.prepare(`INSERT INTO login_fail(ip,ts) VALUES(?,?)`).bind(ip, Date.now()).run(); return err("PIN incorreto", 401); }
    const now = Date.now(), day = mzDay(now);
    const open = await db.prepare(`SELECT id,in_ts FROM shifts WHERE user_id=? AND day=? AND out_ts IS NULL ORDER BY id DESC LIMIT 1`).bind(u.id, day).first();
    const sch = await db.prepare(`SELECT start,end FROM schedules WHERE user_id=? AND dow=?`).bind(u.id, new Date(now + 2 * 3600e3).getUTCDay()).first();
    const tol = +(((await db.prepare(`SELECT v FROM settings WHERE k='late_tolerance'`).first()) || {}).v ?? 10);
    if (body.action === "status") return json({ name: u.name, open: !!open, in_ts: open ? open.in_ts : null });
    if (open) {
      await db.prepare(`UPDATE shifts SET out_ts=? WHERE id=?`).bind(now, open.id).run();
      const end = sch ? hm2min(sch.end) : null, mins = Math.round((now - open.in_ts) / 60e3);
      return json({ name: u.name, action: "saida", ts: now, worked: mins, extra: end != null ? Math.max(0, mzMin(now) - end) : null, early: end != null ? Math.max(0, end - mzMin(now)) : null });
    }
    await db.prepare(`INSERT INTO shifts(user_id,day,in_ts) VALUES(?,?,?)`).bind(u.id, day, now).run();
    const start = sch ? hm2min(sch.start) : null, late = start != null ? mzMin(now) - start : null;
    return json({ name: u.name, action: "entrada", ts: now, late: late != null && late > tol ? late : 0, scheduled: !!sch });
  }

  // ---------- Autenticado ----------
  const user = await auth(req, db);
  if (!user) return err("Sessão expirada", 401);
  const admin = user.role === "admin";
  const mgr = admin || user.role === "manager";

  if (path === "/logout" && m === "POST") {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    await db.prepare(`DELETE FROM sessions WHERE token=?`).bind(t).run();
    return json({ ok: true });
  }
  if (path === "/boot" && m === "GET") {
    const stock = (await db.prepare(`SELECT product_id,cor,size,qty FROM stock`).all()).results;
    const users = (await db.prepare(`SELECT id,name,role,commission,active,ot_rate FROM users ORDER BY id`).all()).results;
    const settings = Object.fromEntries((await db.prepare(`SELECT k,v FROM settings`).all()).results.map(r => [r.k, r.v]));
    return json({ user, stock, users, settings, today: today() });
  }

  // Vendas
  if (path === "/sales" && m === "POST") {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return err("Carrinho vazio");
    for (const i of items) { if (!i.product_id || !(i.qty > 0) || !(i.unit_price >= 0)) return err("Artigo inválido"); }
    let sellerId = user.id;
    if (body.user_id && body.user_id !== user.id) {
      if (!mgr) return err("Só a gerência pode registar em nome de outro vendedor", 403);
      sellerId = +body.user_id;
    }
    if (String(body.phone || "").trim() && !normPhone(body.phone)) return err("Número de telefone inválido. Um número de Moçambique tem 9 dígitos (ex: 84 123 4567).");
    const gross = items.reduce((a, i) => a + Math.round(i.unit_price) * Math.round(i.qty), 0);
    const discount = Math.max(0, Math.min(gross, Math.round(+body.discount || 0)));
    const subtotal = gross - discount;
    const day = mgr && /^\d{4}-\d{2}-\d{2}$/.test(body.day || "") ? body.day : today();
    const r = await db.prepare(`INSERT INTO sales(day,ts,user_id,channel,payment,delivery,subtotal,customer,phone,notes) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(day, Date.now(), sellerId, body.channel || "Loja", body.payment || "", Math.round(+body.delivery || 0), subtotal, (body.customer || "").slice(0, 80), (body.phone || "").slice(0, 30), (body.notes || "").slice(0, 300)).run();
    const saleId = r.meta.last_row_id;
    if (discount) await db.prepare(`UPDATE sales SET discount=? WHERE id=?`).bind(discount, saleId).run();
    const custId = await upsertCustomer(db, { name: (body.customer || "").slice(0, 80), phone: body.phone, source: body.channel });
    if (custId) await db.prepare(`UPDATE sales SET customer_id=? WHERE id=?`).bind(custId, saleId).run();
    if (body.campaign_id || body.source) await db.prepare(`UPDATE sales SET campaign_id=?, source=? WHERE id=?`).bind(body.campaign_id ? +body.campaign_id : null, (body.source || "").slice(0, 60), saleId).run();
    await db.batch(items.map(i => db.prepare(`INSERT INTO sale_items(sale_id,product_id,name,cor,size,qty,unit_price,list_price) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(saleId, i.product_id, (i.name || "").slice(0, 120), i.cor || "-", i.size || "-", Math.round(i.qty), Math.round(i.unit_price), i.list_price == null ? null : Math.round(i.list_price))));
    await adjustStock(db, user, items.map(i => ({ product_id: i.product_id, cor: i.cor || "-", size: i.size || "-", delta: -Math.round(i.qty) })), `venda #${saleId}`);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE day=? AND id<=?`).bind(day, saleId).first();
    return json({ ok: true, id: saleId, number: n.n });
  }
  if (path === "/sales" && m === "GET") {
    const day = url.searchParams.get("day") || today();
    const sales = await saleDetail(db, "s.day=?", [day]);
    const expenses = (await db.prepare(`SELECT e.*, u.name AS by_name FROM expenses e LEFT JOIN users u ON u.id=e.user_id WHERE e.day=? ORDER BY e.id`).bind(day).all()).results;
    return json({ day, sales, expenses });
  }
  const voidM = path.match(/^\/sales\/(\d+)\/void$/);
  if (voidM && m === "POST") {
    if (!mgr) return err("Só a gerência pode anular vendas", 403);
    const s = (await saleDetail(db, "s.id=?", [+voidM[1]]))[0];
    if (!s) return err("Venda não encontrada", 404);
    if (s.void) return err("Já anulada");
    await db.prepare(`UPDATE sales SET void=1, void_by=?, void_reason=? WHERE id=?`).bind(user.id, (body.reason || "").slice(0, 200), s.id).run();
    await adjustStock(db, user, s.items.map(i => ({ product_id: i.product_id, cor: i.cor, size: i.size, delta: i.qty })), `anulação #${s.id}`);
    return json({ ok: true });
  }

  const delM = path.match(/^\/sales\/(\d+)$/);
  if (delM && m === "DELETE") {
    if (!admin) return err("Só o admin pode apagar vendas", 403);
    const s = await db.prepare(`SELECT void FROM sales WHERE id=?`).bind(+delM[1]).first();
    if (!s) return err("Venda não encontrada", 404);
    if (!s.void) return err("Anula a venda primeiro (para o stock voltar)");
    await db.batch([db.prepare(`DELETE FROM sale_items WHERE sale_id=?`).bind(+delM[1]), db.prepare(`DELETE FROM sales WHERE id=?`).bind(+delM[1])]);
    return json({ ok: true });
  }

  // Despesas
  if (path === "/expenses" && m === "POST") {
    const amount = Math.round(+body.amount || 0);
    if (!(amount > 0)) return err("Valor inválido");
    const day = mgr && /^\d{4}-\d{2}-\d{2}$/.test(body.day || "") ? body.day : today();
    await db.prepare(`INSERT INTO expenses(day,type,amount,notes,user_id,ts,paid_cash) VALUES(?,?,?,?,?,?,?)`).bind(day, (body.type || "Outros").slice(0, 60), amount, (body.notes || "").slice(0, 200), user.id, Date.now(), body.paid_cash === 0 ? 0 : 1).run();
    return json({ ok: true });
  }
  const expDel = path.match(/^\/expenses\/(\d+)$/);
  if (expDel && m === "DELETE") {
    if (!mgr) return err("Só a gerência pode apagar despesas", 403);
    await db.prepare(`DELETE FROM expenses WHERE id=?`).bind(+expDel[1]).run();
    return json({ ok: true });
  }

  // Stock (admin)
  if (path === "/stock" && m === "PUT") {
    if (!admin) return err("Só o admin pode alterar stock", 403);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const stmts = [];
    for (const r of rows) {
      if (!r.product_id) continue;
      const cor = r.cor || "-", size = String(r.size || "-");
      const qty = r.qty === "" || r.qty == null ? null : Math.max(0, Math.round(+r.qty));
      const cur = await db.prepare(`SELECT qty FROM stock WHERE product_id=? AND cor=? AND size=?`).bind(r.product_id, cor, size).first();
      stmts.push(db.prepare(`INSERT INTO stock(product_id,cor,size,qty) VALUES(?,?,?,?) ON CONFLICT(product_id,cor,size) DO UPDATE SET qty=excluded.qty`).bind(r.product_id, cor, size, qty));
      if (!cur || cur.qty !== qty) stmts.push(db.prepare(`INSERT INTO stock_log(ts,user_id,product_id,cor,size,before,after,reason) VALUES(?,?,?,?,?,?,?,?)`).bind(Date.now(), user.id, r.product_id, cor, size, cur ? cur.qty : null, qty, body.reason || "ajuste manual"));
    }
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
    return json({ ok: true, n: rows.length });
  }
  if (path === "/stock/import" && m === "POST") {
    if (!admin) return err("Só o admin", 403);
    const src = String(body.url || "");
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(src)) return err("Link inválido");
    const t = await (await fetch(src)).text();
    const MK = { dourado: "ouro", prateado: "prata" };
    const rows = parseCSV(t).slice(1).map(r => ({ product_id: (r[5] || "").trim(), cor: MK[(r[2] || "").trim().toLowerCase()] || "-", size: ((r[3] || "").trim().replace(/^—$/, "-")) || "-", qty: (r[4] || "").trim() })).filter(r => r.product_id);
    const stmts = rows.map(r => db.prepare(`INSERT INTO stock(product_id,cor,size,qty) VALUES(?,?,?,?) ON CONFLICT(product_id,cor,size) DO UPDATE SET qty=excluded.qty`).bind(r.product_id, r.cor, r.size, r.qty === "" || isNaN(+r.qty) ? null : Math.max(0, Math.round(+r.qty))));
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
    await db.prepare(`INSERT INTO stock_log(ts,user_id,product_id,cor,size,before,after,reason) VALUES(?,?,?,?,?,?,?,?)`).bind(Date.now(), user.id, "*", "", "", null, rows.length, "importação Google Sheet").run();
    return json({ ok: true, n: rows.length, withQty: rows.filter(r => r.qty !== "").length });
  }
  if (path === "/stock/log" && m === "GET") {
    const pid = url.searchParams.get("product");
    const rows = (await db.prepare(`SELECT l.*, u.name AS by_name FROM stock_log l LEFT JOIN users u ON u.id=l.user_id ${pid ? "WHERE l.product_id=?" : ""} ORDER BY l.id DESC LIMIT 200`).bind(...(pid ? [pid] : [])).all()).results;
    return json({ rows });
  }

  // Equipa (admin)
  if (path === "/users" && m === "POST") {
    if (!admin) return err("Só o admin", 403);
    const name = String(body.name || "").trim(), pin = String(body.pin || "");
    if (!name || !/^\d{4,8}$/.test(pin)) return err("Nome e PIN (4–8 dígitos) obrigatórios");
    try {
      await db.prepare(`INSERT INTO users(name,pin_hash,role,commission,created) VALUES(?,?,?,?,?)`).bind(name, await sha(pin), (["admin","manager"].includes(body.role) ? body.role : "seller"), Math.max(0, +body.commission || 0), today()).run();
    } catch (e) { return err("Esse PIN já está a ser usado. Escolhe outro."); }
    return json({ ok: true });
  }
  const uM = path.match(/^\/users\/(\d+)$/);
  if (uM && m === "PUT") {
    if (!admin) return err("Só o admin", 403);
    const id = +uM[1];
    if (id === user.id && (body.active === 0 || (body.role && body.role !== "admin"))) return err("Não podes desativar ou despromover a tua própria conta");
    const sets = [], b = [];
    if (body.name) { sets.push("name=?"); b.push(String(body.name).trim()); }
    if (body.pin) { if (!/^\d{4,8}$/.test(body.pin)) return err("PIN 4–8 dígitos"); sets.push("pin_hash=?"); b.push(await sha(String(body.pin))); }
    if (body.role) { sets.push("role=?"); b.push((["admin","manager"].includes(body.role) ? body.role : "seller")); }
    if (body.commission != null) { sets.push("commission=?"); b.push(Math.max(0, +body.commission || 0)); }
    if (body.active != null) { sets.push("active=?"); b.push(body.active ? 1 : 0); }
    if (!sets.length) return err("Nada para alterar");
    try { await db.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).bind(...b, id).run(); }
    catch (e) { return err("Esse PIN já está a ser usado. Escolhe outro."); }
    if (body.active === 0 || body.pin) await db.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();
    return json({ ok: true });
  }

  // Clientes
  if (path === "/customers/lookup" && m === "GET") {
    const ph = normPhone(url.searchParams.get("phone"));
    if (!ph) return json({ customer: null });
    const c = await db.prepare(`${CUST_STATS} WHERE c.phone=? GROUP BY c.id`).bind(ph).first();
    return json({ customer: c || null });
  }
  if (path === "/customers" && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    // liga vendas antigas com telefone a clientes
    const orphan = (await db.prepare(`SELECT id,customer,phone,channel FROM sales WHERE customer_id IS NULL AND phone<>'' LIMIT 300`).all()).results;
    for (const o of orphan) { const cid = await upsertCustomer(db, { name: o.customer, phone: o.phone, source: o.channel }); await db.prepare(`UPDATE sales SET customer_id=? WHERE id=?`).bind(cid || 0, o.id).run(); }
    const q = (url.searchParams.get("q") || "").trim();
    const sort = { total: "total DESC", last: "last DESC", name: "c.name COLLATE NOCASE" }[url.searchParams.get("sort")] || "last DESC";
    const where = q ? `WHERE c.name LIKE ? OR c.phone LIKE ? OR c.instagram LIKE ?` : "";
    const b = q ? [`%${q}%`, `%${q.replace(/\D/g, "") || q}%`, `%${q}%`] : [];
    const rows = (await db.prepare(`${CUST_STATS} ${where} GROUP BY c.id ORDER BY ${sort} LIMIT 300`).bind(...b).all()).results;
    const tot = await db.prepare(`SELECT COUNT(*) n FROM customers`).first();
    return json({ rows, total: tot.n });
  }
  if (path === "/customers.csv" && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    const rows = (await db.prepare(`${CUST_STATS} GROUP BY c.id ORDER BY c.name COLLATE NOCASE`).all()).results;
    const head = "Nome,Telefone,Compras,Total gasto (MT),Última compra,Aniversário,Tamanho anel,Tamanho mascote,Instagram,Origem,Notas,Cliente desde";
    const csv = [head].concat(rows.map(r => [r.name, "+" + r.phone, r.n, r.total, r.last ? new Date(r.last + 7200e3).toISOString().slice(0, 10) : "", r.birthday || "", r.ring_size || "", r.wrist_size || "", r.instagram || "", r.source || "", r.notes || "", r.created || ""].map(v => csvCell(v ?? "")).join(","))).join("\n");
    return new Response("﻿" + csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="clientes-mta-${today()}.csv"`, "cache-control": "no-store" } });
  }
  const cM = path.match(/^\/customers\/(\d+)$/);
  if (cM && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    const c = await db.prepare(`${CUST_STATS} WHERE c.id=? GROUP BY c.id`).bind(+cM[1]).first();
    if (!c) return err("Cliente não encontrado", 404);
    const sales = await saleDetail(db, "s.customer_id=?", [c.id]);
    return json({ customer: c, sales: sales.reverse() });
  }
  const CF = ["name", "birthday", "ring_size", "wrist_size", "instagram", "source", "notes"];
  if (path === "/customers" && m === "POST") {
    const ph = normPhone(body.phone);
    if (!ph) return err("Telefone inválido");
    const ex = await db.prepare(`SELECT id FROM customers WHERE phone=?`).bind(ph).first();
    if (ex) return err("Já existe um cliente com esse telefone");
    const r = await db.prepare(`INSERT INTO customers(phone,${CF.join(",")},created,updated) VALUES(?,${CF.map(() => "?").join(",")},?,?)`).bind(ph, ...CF.map(k => String(body[k] || "").slice(0, 300)), today(), Date.now()).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (cM && m === "DELETE") {
    if (!mgr) return err("Só a gerência", 403);
    const id = +cM[1];
    // As vendas ficam no histórico, só deixam de estar ligadas ao cliente (0 = não voltar a criar a partir da venda)
    await db.batch([db.prepare(`UPDATE sales SET customer_id=0 WHERE customer_id=?`).bind(id), db.prepare(`DELETE FROM campaign_sends WHERE customer_id=?`).bind(id), db.prepare(`DELETE FROM customers WHERE id=?`).bind(id)]);
    return json({ ok: true });
  }
  if (cM && m === "PUT") {
    if (!mgr) return err("Só a gerência", 403);
    const sets = [], b = [];
    CF.forEach(k => { if (body[k] != null) { sets.push(`${k}=?`); b.push(String(body[k]).slice(0, 300)); } });
    if (body.phone != null) { const ph = normPhone(body.phone); if (!ph) return err("Telefone inválido"); sets.push("phone=?"); b.push(ph); }
    if (!sets.length) return err("Nada para alterar");
    try { await db.prepare(`UPDATE customers SET ${sets.join(",")}, updated=? WHERE id=?`).bind(...b, Date.now(), +cM[1]).run(); }
    catch (e) { return err("Já existe um cliente com esse telefone"); }
    return json({ ok: true });
  }

  // Anúncios Meta (Marketing API). Segredos no Cloudflare: META_TOKEN, META_ACT
  if (path === "/ads" && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : today().slice(0, 7);
    const since = month + "-01";
    const endD = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
    const until = endD < today() ? endD : today();
    // Vendas da loja vindas de anúncios (origem escolhida no POS)
    const pos = await db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(subtotal),0) revenue FROM sales WHERE void=0 AND (source IN ('Instagram','Facebook') OR source LIKE 'Anúncio%') AND day BETWEEN ? AND ?`).bind(since, until).first();
    const rate = +((await db.prepare(`SELECT v FROM settings WHERE k='usd_rate'`).first()) || {}).v || 64;
    if (!env.META_TOKEN || !env.META_ACT) return json({ month, configured: false, pos, rate });
    const key = `ads:${month}`;
    const cached = await db.prepare(`SELECT v FROM settings WHERE k=?`).bind(key).first();
    if (cached && !url.searchParams.get("fresh")) { const c = JSON.parse(cached.v); if (Date.now() - c.ts < 30 * 60e3) return json({ ...c.data, pos, rate, cached: true }); }
    const act = String(env.META_ACT).replace(/^act_/, "");
    const G = "https://graph.facebook.com/v26.0";
    const tr = encodeURIComponent(JSON.stringify({ since, until }));
    const fields = "campaign_id,campaign_name,spend,impressions,reach,clicks,actions,cost_per_action_type";
    try {
      const [accR, campR, totR] = await Promise.all([
        fetch(`${G}/act_${act}?fields=name,currency&access_token=${env.META_TOKEN}`),
        fetch(`${G}/act_${act}/insights?level=campaign&fields=${fields}&time_range=${tr}&limit=200&access_token=${env.META_TOKEN}`),
        fetch(`${G}/act_${act}/insights?fields=spend,impressions,reach,clicks,actions&time_range=${tr}&access_token=${env.META_TOKEN}`),
      ]);
      const acc = await accR.json(), camp = await campR.json(), tot = await totR.json();
      const e = acc.error || camp.error || tot.error;
      if (e) return json({ month, configured: true, error: e.message || "Erro Meta", pos, rate });
      const act_ = (arr, t) => +((arr || []).find(a => a.action_type === t) || {}).value || 0;
      const MSG = "onsite_conversion.messaging_conversation_started_7d", FIRST = "onsite_conversion.messaging_first_reply";
      const pick = r => ({ spend: +r.spend || 0, impressions: +r.impressions || 0, reach: +r.reach || 0, clicks: +r.clicks || 0, conversations: act_(r.actions, MSG), new_contacts: act_(r.actions, FIRST) });
      const data = { month, since, until, configured: true, account: acc.name, currency: acc.currency, total: pick((tot.data || [])[0] || {}),
        campaigns: (camp.data || []).map(r => ({ id: r.campaign_id, name: r.campaign_name, ...pick(r) })).sort((a, b) => b.spend - a.spend) };
      await db.prepare(`INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(key, JSON.stringify({ ts: Date.now(), data })).run();
      return json({ ...data, pos, rate });
    } catch (e) { return json({ month, configured: true, error: "Não consegui ligar ao Meta: " + e.message, pos, rate }); }
  }

  // Campanhas
  if (path === "/campaigns/active" && m === "GET") {
    const d = today();
    const rows = (await db.prepare(`SELECT id,name,type FROM campaigns WHERE active=1 AND (start IS NULL OR start='' OR start<=?) AND (end IS NULL OR end='' OR end>=?) ORDER BY id DESC`).bind(d, d).all()).results;
    return json({ rows });
  }
  if (path === "/campaigns" && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    const rows = (await db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM sales s WHERE s.campaign_id=c.id AND s.void=0) n,
        (SELECT COALESCE(SUM(subtotal),0) FROM sales s WHERE s.campaign_id=c.id AND s.void=0) revenue,
        (SELECT COUNT(*) FROM sales s WHERE s.campaign_id=c.id AND s.void=0 AND s.customer_id IS NOT NULL AND s.customer_id>0 AND NOT EXISTS (SELECT 1 FROM sales p WHERE p.customer_id=s.customer_id AND p.void=0 AND p.id<s.id)) new_customers,
        (SELECT COUNT(*) FROM campaign_sends w WHERE w.campaign_id=c.id) sent,
        (SELECT COUNT(DISTINCT w.customer_id) FROM campaign_sends w JOIN sales s ON s.customer_id=w.customer_id AND s.void=0 AND s.ts>w.ts AND s.ts<w.ts+14*86400000 WHERE w.campaign_id=c.id) bought_after
      FROM campaigns c ORDER BY c.active DESC, c.id DESC`).all()).results;
    const src = (await db.prepare(`SELECT COALESCE(NULLIF(source,''),'Sem informação') source, COUNT(*) n, SUM(subtotal) revenue FROM sales WHERE void=0 AND campaign_id IS NULL AND day>=? GROUP BY 1 ORDER BY revenue DESC`).bind(new Date(Date.now() + 7200e3 - 30 * 864e5).toISOString().slice(0, 10)).all()).results;
    return json({ rows, sources30: src });
  }
  const CAF = ["name", "type", "start", "end", "message", "notes"];
  if (path === "/campaigns" && m === "POST") {
    if (!mgr) return err("Só a gerência", 403);
    if (!String(body.name || "").trim()) return err("Dá um nome à campanha");
    const r = await db.prepare(`INSERT INTO campaigns(${CAF.join(",")},cost,active,created) VALUES(${CAF.map(() => "?").join(",")},?,1,?)`).bind(...CAF.map(k => String(body[k] || "").slice(0, 1000)), Math.round(+body.cost || 0), today()).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }
  const caM = path.match(/^\/campaigns\/(\d+)$/);
  if (caM && m === "PUT") {
    if (!mgr) return err("Só a gerência", 403);
    const sets = [], b = [];
    CAF.forEach(k => { if (body[k] != null) { sets.push(`${k}=?`); b.push(String(body[k]).slice(0, 1000)); } });
    if (body.cost != null) { sets.push("cost=?"); b.push(Math.round(+body.cost || 0)); }
    if (body.active != null) { sets.push("active=?"); b.push(body.active ? 1 : 0); }
    if (!sets.length) return err("Nada para alterar");
    await db.prepare(`UPDATE campaigns SET ${sets.join(",")} WHERE id=?`).bind(...b, +caM[1]).run();
    return json({ ok: true });
  }
  const audM = path.match(/^\/campaigns\/(\d+)\/audience$/);
  if (audM && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    const seg = url.searchParams.get("seg") || "all", cid = +audM[1];
    let having = "", where = "WHERE c.phone<>''", b = [];
    if (seg === "vip") { having = "HAVING total>=?"; b.push(+url.searchParams.get("min") || 5000); }
    else if (seg === "inactive") { having = "HAVING last IS NOT NULL AND last<?"; b.push(Date.now() - (+url.searchParams.get("days") || 60) * 864e5); }
    else if (seg === "nobuy") { having = "HAVING n=0"; }
    else if (seg === "bday") { where += " AND substr(c.birthday,6,2)=?"; b.unshift(today().slice(5, 7)); }
    else if (seg === "bought") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200);
      if (!ids.length) return json({ rows: [] });
      where += ` AND c.id IN (SELECT s.customer_id FROM sales s JOIN sale_items i ON i.sale_id=s.id WHERE s.void=0 AND i.product_id IN (${ids.map(() => "?").join(",")}))`;
      b = ids.concat(b);
    }
    const rows = (await db.prepare(`SELECT c.id,c.name,c.phone, COUNT(s.id) n, COALESCE(SUM(s.subtotal),0) total, MAX(s.ts) last, (SELECT ts FROM campaign_sends w WHERE w.campaign_id=${cid} AND w.customer_id=c.id) sent_ts FROM customers c LEFT JOIN sales s ON s.customer_id=c.id AND s.void=0 ${where} GROUP BY c.id ${having} ORDER BY c.name COLLATE NOCASE LIMIT 1000`).bind(...b).all()).results;
    return json({ rows });
  }
  const sentM = path.match(/^\/campaigns\/(\d+)\/sent$/);
  if (sentM && m === "POST") {
    if (!mgr) return err("Só a gerência", 403);
    await db.prepare(`INSERT INTO campaign_sends(campaign_id,customer_id,ts,user_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING`).bind(+sentM[1], +body.customer_id, Date.now(), user.id).run();
    return json({ ok: true });
  }

  // Gastos mensais (Giving)
  async function metaSpend(mo) {
    if (!env.META_TOKEN || !env.META_ACT) return null;
    const key = `adspend:${mo}`;
    const c = await db.prepare(`SELECT v FROM settings WHERE k=?`).bind(key).first();
    if (c) { const x = JSON.parse(c.v); if (Date.now() - x.ts < 6 * 3600e3) return x.data; }
    try {
      const act = String(env.META_ACT).replace(/^act_/, ""), G = "https://graph.facebook.com/v26.0";
      const endD = new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).toISOString().slice(0, 10);
      const tr = encodeURIComponent(JSON.stringify({ since: mo + "-01", until: endD < today() ? endD : today() }));
      const [acc, ins] = await Promise.all([fetch(`${G}/act_${act}?fields=currency&access_token=${env.META_TOKEN}`).then(r => r.json()), fetch(`${G}/act_${act}/insights?fields=spend&time_range=${tr}&access_token=${env.META_TOKEN}`).then(r => r.json())]);
      if (acc.error || ins.error) return { error: (acc.error || ins.error).message };
      const spend = +(((ins.data || [])[0] || {}).spend || 0);
      const rate = +((await db.prepare(`SELECT v FROM settings WHERE k='usd_rate'`).first()) || {}).v || 64;
      const data = { spend, currency: acc.currency, mt: Math.round(acc.currency === "MZN" ? spend : spend * rate), rate };
      await db.prepare(`INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(key, JSON.stringify({ ts: Date.now(), data })).run();
      return data;
    } catch (e) { return { error: e.message }; }
  }
  const monthRange = mo => { const end = new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).toISOString().slice(0, 10); return [mo + "-01", end]; };
  if (path === "/giving" && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    const mo = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : today().slice(0, 7);
    await ensureLogSeed();
    if (!(await db.prepare(`SELECT v FROM settings WHERE k='giving_seeded_nov26'`).first())) {
      const st = GIVING_SEED.map(r => db.prepare(`INSERT INTO giving(day,description,category,amount,method,paid_by,notes,recurring,status,user_id,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(r.day, r.description, r.category, r.amount, r.method || "", r.paid_by || "", r.notes || "", r.recurring, r.status, user.id, Date.now()));
      st.push(db.prepare(`INSERT INTO settings(k,v) VALUES('giving_seeded_nov26','1') ON CONFLICT(k) DO NOTHING`));
      await db.batch(st);
    }
    const [a, b] = monthRange(mo);
    const rows = (await db.prepare(`SELECT g.id,g.day,g.description,g.category,g.amount,g.method,g.paid_by,g.notes,g.recurring,g.has_receipt,g.status, u.name AS by_name FROM giving g LEFT JOIN users u ON u.id=g.user_id WHERE g.day BETWEEN ? AND ? ORDER BY g.day DESC, g.id DESC`).bind(a, b).all()).results;
    const till = (await db.prepare(`SELECT e.id,e.day,e.type,e.amount,e.notes, u.name AS by_name FROM expenses e LEFT JOIN users u ON u.id=e.user_id WHERE e.day BETWEEN ? AND ? ORDER BY e.day DESC`).bind(a, b).all()).results;
    const sales = await db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(subtotal),0) products, COALESCE(SUM(delivery),0) delivery FROM sales WHERE void=0 AND day BETWEEN ? AND ?`).bind(a, b).first();
    const comm = (await db.prepare(`SELECT u.name, u.commission pct, SUM(s.subtotal) total FROM sales s JOIN users u ON u.id=s.user_id WHERE s.void=0 AND s.day BETWEEN ? AND ? AND u.commission>0 GROUP BY u.id`).bind(a, b).all()).results;
    // Logística: pagamento da encomenda conta no mês da encomenda; levantamento no mês da chegada
    const logOrders = (await db.prepare(`SELECT id,name,order_day day,mzn amount,via,brand,pay_method method FROM logistics WHERE mzn>0 AND order_day BETWEEN ? AND ? ORDER BY order_day DESC`).bind(a, b).all()).results;
    const logPickups = (await db.prepare(`SELECT id,name,COALESCE(NULLIF(arrival_day,''),order_day) day,pickup amount,via,brand,pickup_method method FROM logistics WHERE pickup>0 AND COALESCE(NULLIF(arrival_day,''),order_day) BETWEEN ? AND ? ORDER BY day DESC`).bind(a, b).all()).results;
    const meta = await metaSpend(mo);
    return json({ month: mo, rows, till, logOrders, logPickups, meta, sales, commissions: comm.map(c => ({ ...c, value: Math.round(c.total * c.pct / 100) })) });
  }
  const GF = ["day", "description", "category", "method", "paid_by", "notes"];
  async function saveReceipt(id, data) {
    if (!data) return;
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(data) || data.length > 1500000) throw new Error("Foto inválida ou demasiado grande");
    await db.prepare(`INSERT INTO receipts(giving_id,data) VALUES(?,?) ON CONFLICT(giving_id) DO UPDATE SET data=excluded.data`).bind(id, data).run();
    await db.prepare(`UPDATE giving SET has_receipt=1 WHERE id=?`).bind(id).run();
  }
  if (path === "/giving" && m === "POST") {
    if (!mgr) return err("Só a gerência", 403);
    const amount = Math.round(+body.amount || 0);
    const status = body.status === "Por pagar" ? "Por pagar" : "Pago";
    if (!(amount > 0) && status === "Pago") return err("Escreve o valor pago");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.day || "")) return err("Data inválida");
    const r = await db.prepare(`INSERT INTO giving(${GF.join(",")},amount,recurring,status,user_id,ts) VALUES(${GF.map(() => "?").join(",")},?,?,?,?,?)`).bind(...GF.map(k => String(body[k] || "").slice(0, 300)), amount, body.recurring ? 1 : 0, status, user.id, Date.now()).run();
    try { await saveReceipt(r.meta.last_row_id, body.receipt); } catch (e) { return err(e.message); }
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (path === "/giving/copy" && m === "POST") {
    if (!mgr) return err("Só a gerência", 403);
    const to = /^\d{4}-\d{2}$/.test(body.to || "") ? body.to : today().slice(0, 7);
    const prev = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
    const [pa, pb] = monthRange(prev), [ta, tb] = monthRange(to);
    const rec = (await db.prepare(`SELECT * FROM giving WHERE recurring=1 AND day BETWEEN ? AND ?`).bind(pa, pb).all()).results;
    let n = 0;
    for (const g of rec) {
      const ex = await db.prepare(`SELECT id FROM giving WHERE day BETWEEN ? AND ? AND description=? AND category=?`).bind(ta, tb, g.description, g.category).first();
      if (ex) continue;
      const d = to + g.day.slice(7); const day = d > tb ? tb : d;
      await db.prepare(`INSERT INTO giving(day,description,category,amount,method,paid_by,notes,recurring,status,user_id,ts) VALUES(?,?,?,?,?,?,?,1,'Por pagar',?,?)`).bind(to + "-01", g.description, g.category, g.amount, g.method, g.paid_by, "", user.id, Date.now()).run();
      n++;
    }
    return json({ ok: true, n, from: prev });
  }
  const gM = path.match(/^\/giving\/(\d+)$/);
  if (gM && m === "PUT") {
    if (!mgr) return err("Só a gerência", 403);
    const sets = [], b = [];
    GF.forEach(k => { if (body[k] != null) { sets.push(`${k}=?`); b.push(String(body[k]).slice(0, 300)); } });
    if (body.status != null) { sets.push("status=?"); b.push(body.status === "Por pagar" ? "Por pagar" : "Pago"); }
    if (body.amount != null) { const a = Math.round(+body.amount || 0); if (!(a > 0) && body.status !== "Por pagar") return err("Escreve o valor pago"); sets.push("amount=?"); b.push(a); }
    if (body.recurring != null) { sets.push("recurring=?"); b.push(body.recurring ? 1 : 0); }
    if (sets.length) await db.prepare(`UPDATE giving SET ${sets.join(",")} WHERE id=?`).bind(...b, +gM[1]).run();
    try { await saveReceipt(+gM[1], body.receipt); } catch (e) { return err(e.message); }
    return json({ ok: true });
  }
  if (gM && m === "DELETE") {
    if (!mgr) return err("Só a gerência", 403);
    await db.batch([db.prepare(`DELETE FROM receipts WHERE giving_id=?`).bind(+gM[1]), db.prepare(`DELETE FROM giving WHERE id=?`).bind(+gM[1])]);
    return json({ ok: true });
  }
  const grM = path.match(/^\/giving\/(\d+)\/receipt$/);
  if (grM && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    const r = await db.prepare(`SELECT data FROM receipts WHERE giving_id=?`).bind(+grM[1]).first();
    if (!r) return err("Sem recibo", 404);
    return json({ data: r.data });
  }

  async function ensureLogSeed() {
    if (await db.prepare(`SELECT v FROM settings WHERE k='logistics_seeded'`).first()) return;
    const n = await db.prepare(`SELECT COUNT(*) n FROM logistics`).first();
    if (!n.n) {
      const st = LOG_SEED.map(r => db.prepare(`INSERT INTO logistics(name,order_day,arrival_day,status,via,usd,mzn,pickup,brand,ts) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(r.name, r.order_day, r.arrival_day || "", r.status, r.via, r.usd, r.mzn, r.pickup, r.brand || "", Date.now()));
      for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
    }
    await db.prepare(`INSERT INTO settings(k,v) VALUES('logistics_seeded','1') ON CONFLICT(k) DO NOTHING`).run();
  }
  // Logística (encomendas da China)
  if (path.startsWith("/logistics") && !mgr) return err("Só a gerência", 403);
  if (path === "/logistics" && m === "GET") {
    await ensureLogSeed();
    const rows = (await db.prepare(`SELECT id,name,order_day,arrival_day,status,via,usd,mzn,pickup,supplier,brand,tracking,notes,has_file,pay_method,pickup_method FROM logistics ORDER BY order_day DESC, id DESC`).all()).results;
    return json({ rows });
  }
  const LF = ["name", "order_day", "arrival_day", "status", "via", "supplier", "brand", "tracking", "notes", "pay_method", "pickup_method"];
  const numOrNull = v => v === "" || v == null ? null : +String(v).replace(",", ".");
  async function saveLogFile(id, data) {
    if (!data) return;
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(data) || data.length > 1500000) throw new Error("Foto inválida ou demasiado grande");
    await db.prepare(`INSERT INTO logistics_files(log_id,data) VALUES(?,?) ON CONFLICT(log_id) DO UPDATE SET data=excluded.data`).bind(id, data).run();
    await db.prepare(`UPDATE logistics SET has_file=1 WHERE id=?`).bind(id).run();
  }
  if (path === "/logistics" && m === "POST") {
    if (!String(body.name || "").trim()) return err("Escreve o nome da encomenda");
    const r = await db.prepare(`INSERT INTO logistics(${LF.join(",")},usd,mzn,pickup,user_id,ts) VALUES(${LF.map(() => "?").join(",")},?,?,?,?,?)`).bind(...LF.map(k => String(body[k] || "").slice(0, 300)), numOrNull(body.usd), body.mzn === "" || body.mzn == null ? null : Math.round(+body.mzn), body.pickup === "" || body.pickup == null ? null : Math.round(+body.pickup), user.id, Date.now()).run();
    try { await saveLogFile(r.meta.last_row_id, body.file); } catch (e) { return err(e.message); }
    return json({ ok: true, id: r.meta.last_row_id });
  }
  const lM = path.match(/^\/logistics\/(\d+)$/);
  if (lM && m === "PUT") {
    const sets = [], b = [];
    LF.forEach(k => { if (body[k] != null) { sets.push(`${k}=?`); b.push(String(body[k]).slice(0, 300)); } });
    if (body.usd !== undefined) { sets.push("usd=?"); b.push(numOrNull(body.usd)); }
    ["mzn", "pickup"].forEach(k => { if (body[k] !== undefined) { sets.push(`${k}=?`); b.push(body[k] === "" || body[k] == null ? null : Math.round(+body[k])); } });
    if (sets.length) await db.prepare(`UPDATE logistics SET ${sets.join(",")} WHERE id=?`).bind(...b, +lM[1]).run();
    try { await saveLogFile(+lM[1], body.file); } catch (e) { return err(e.message); }
    return json({ ok: true });
  }
  if (lM && m === "DELETE") {
    await db.batch([db.prepare(`DELETE FROM logistics_files WHERE log_id=?`).bind(+lM[1]), db.prepare(`DELETE FROM logistics WHERE id=?`).bind(+lM[1])]);
    return json({ ok: true });
  }
  const lfM = path.match(/^\/logistics\/(\d+)\/file$/);
  if (lfM && m === "GET") {
    const r = await db.prepare(`SELECT data FROM logistics_files WHERE log_id=?`).bind(+lfM[1]).first();
    if (!r) return err("Sem anexo", 404);
    return json({ data: r.data });
  }

  // Dispositivo da loja
  if (path === "/devices" && m === "GET") { if (!admin) return err("Só o admin", 403); return json({ rows: (await db.prepare(`SELECT substr(token,1,6) short,token,name,active,created FROM devices ORDER BY created DESC`).all()).results.map(r => ({ ...r, token: undefined })) }); }
  if (path === "/devices" && m === "POST") {
    if (!admin) return err("Só o admin pode autorizar dispositivos", 403);
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, "0")).join("");
    await db.batch([db.prepare(`INSERT INTO devices(token,name,active,created,user_id) VALUES(?,?,1,?,?)`).bind(token, (body.name || "Tablet da loja").slice(0, 60), Date.now(), user.id), db.prepare(`INSERT INTO settings(k,v) VALUES('attendance_start',?) ON CONFLICT(k) DO NOTHING`).bind(today())]);
    return json({ ok: true, token });
  }
  const dvM = path.match(/^\/devices\/([0-9a-f]{6})$/);
  if (dvM && m === "DELETE") { if (!admin) return err("Só o admin", 403); await db.prepare(`UPDATE devices SET active=0 WHERE substr(token,1,6)=?`).bind(dvM[1]).run(); return json({ ok: true }); }

  // Horários
  const schM = path.match(/^\/users\/(\d+)\/schedule$/);
  if (schM && m === "GET") { if (!mgr) return err("Só a gerência", 403); return json({ rows: (await db.prepare(`SELECT dow,start,end FROM schedules WHERE user_id=?`).bind(+schM[1]).all()).results }); }
  if (schM && m === "PUT") {
    if (!admin) return err("Só o admin pode alterar horários", 403);
    const uid = +schM[1], st = [db.prepare(`DELETE FROM schedules WHERE user_id=?`).bind(uid)];
    (body.rows || []).forEach(r => { if (hm2min(r.start) != null && hm2min(r.end) != null) st.push(db.prepare(`INSERT INTO schedules(user_id,dow,start,end) VALUES(?,?,?,?)`).bind(uid, +r.dow, r.start, r.end)); });
    if (body.ot_rate != null) st.push(db.prepare(`UPDATE users SET ot_rate=? WHERE id=?`).bind(Math.max(0, Math.round(+body.ot_rate || 0)), uid));
    await db.batch(st);
    return json({ ok: true });
  }

  // Assiduidade (relatório mensal)
  if (path === "/attendance" && m === "GET") {
    if (!mgr) return err("Só a gerência", 403);
    const mo = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : today().slice(0, 7);
    const last = new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).getUTCDate();
    const tol = +(((await db.prepare(`SELECT v FROM settings WHERE k='late_tolerance'`).first()) || {}).v ?? 10);
    const aStart = ((await db.prepare(`SELECT v FROM settings WHERE k='attendance_start'`).first()) || {}).v || "9999-12-31";
    const users = (await db.prepare(`SELECT id,name,ot_rate,created FROM users WHERE active=1 AND id IN (SELECT DISTINCT user_id FROM schedules UNION SELECT DISTINCT user_id FROM shifts WHERE day LIKE ?)`).bind(mo + "%").all()).results;
    const sch = (await db.prepare(`SELECT * FROM schedules`).all()).results;
    const shifts = (await db.prepare(`SELECT * FROM shifts WHERE day LIKE ? ORDER BY in_ts`).bind(mo + "%").all()).results;
    const td = today(), out = [];
    for (const u of users) {
      const days = [], T = { late_n: 0, late_min: 0, absent: 0, early_min: 0, extra_min: 0, worked_min: 0, open: 0 };
      for (let d = 1; d <= last; d++) {
        const day = `${mo}-${String(d).padStart(2, "0")}`; if (day > td) break;
        const dow = new Date(day + "T12:00:00Z").getUTCDay();
        const s = sch.find(x => x.user_id === u.id && x.dow === dow);
        const sh = shifts.filter(x => x.user_id === u.id && x.day === day);
        if (!s && !sh.length) continue;
        const r = { day, dow, start: s ? s.start : null, end: s ? s.end : null, shifts: sh.map(x => ({ id: x.id, in_ts: x.in_ts, out_ts: x.out_ts, note: x.note, edited: !!x.edited_by })), late: 0, early: 0, extra: 0, worked: 0, absent: false };
        if (sh.length) {
          const first = sh[0], lastS = sh[sh.length - 1];
          sh.forEach(x => { if (x.out_ts) r.worked += Math.round((x.out_ts - x.in_ts) / 60e3); else if (day < td) T.open++; });
          if (s) {
            const st = hm2min(s.start), en = hm2min(s.end), lin = mzMin(first.in_ts) - st;
            if (lin > tol) { r.late = lin; T.late_n++; T.late_min += lin; }
            if (lastS.out_ts) { const o = mzMin(lastS.out_ts); if (o > en) r.extra = o - en; else if (o < en) r.early = en - o; }
          } else r.extra = r.worked; // dia de folga trabalhado conta tudo como extra
        } else if (s && day < td && day >= aStart && day >= (u.created || "")) { r.absent = true; T.absent++; }
        else if (!sh.length) continue;
        T.early_min += r.early; T.extra_min += r.extra; T.worked_min += r.worked;
        days.push(r);
      }
      out.push({ id: u.id, name: u.name, ot_rate: u.ot_rate, totals: { ...T, extra_value: Math.round(T.extra_min / 60 * (u.ot_rate || 0)) }, days });
    }
    return json({ month: mo, tolerance: tol, rows: out });
  }
  const shM = path.match(/^\/shifts\/(\d+)$/);
  if ((path === "/shifts" && m === "POST") || (shM && (m === "PUT" || m === "DELETE"))) {
    if (!mgr) return err("Só a gerência pode corrigir o ponto", 403);
    if (m === "DELETE") { await db.prepare(`DELETE FROM shifts WHERE id=?`).bind(+shM[1]).run(); return json({ ok: true }); }
    const toTs = (day, hm) => { const mm = hm2min(hm); return mm == null ? null : Date.parse(day + "T00:00:00Z") - 2 * 3600e3 + mm * 60e3; };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day || "") ? body.day : null; if (!day) return err("Data inválida");
    const inTs = toTs(day, body.in), outTs = toTs(day, body.out);
    if (inTs == null) return err("Hora de entrada inválida");
    if (outTs != null && outTs <= inTs) return err("A saída tem de ser depois da entrada");
    const note = (body.note || "").slice(0, 200);
    if (m === "POST") await db.prepare(`INSERT INTO shifts(user_id,day,in_ts,out_ts,edited_by,note) VALUES(?,?,?,?,?,?)`).bind(+body.user_id, day, inTs, outTs, user.id, note).run();
    else await db.prepare(`UPDATE shifts SET in_ts=?, out_ts=?, edited_by=?, note=? WHERE id=?`).bind(inTs, outTs, user.id, note, +shM[1]).run();
    return json({ ok: true });
  }

  // Caixa (cash na loja)
  if (path === "/cash" && m === "GET") {
    const last = await db.prepare(`SELECT c.*, u.name AS by_name FROM cash_moves c LEFT JOIN users u ON u.id=c.user_id WHERE c.type='recolha' ORDER BY c.id DESC LIMIT 1`).first();
    const since = last ? last.ts : 0;
    const inn = await db.prepare(`SELECT COALESCE(SUM(subtotal+delivery),0) t, COUNT(*) n FROM sales WHERE void=0 AND payment='Cash'`).first();
    const exp = await db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE paid_cash=1`).first();
    const mv = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='recolha' THEN -amount ELSE amount END),0) t FROM cash_moves`).first();
    const balance = inn.t - exp.t + mv.t;
    const sales = (await db.prepare(`SELECT s.id,s.day,s.ts,s.subtotal,s.delivery,s.customer,u.name AS seller FROM sales s JOIN users u ON u.id=s.user_id WHERE s.void=0 AND s.payment='Cash' AND s.ts>? ORDER BY s.id`).bind(since).all()).results;
    const expenses = (await db.prepare(`SELECT e.id,e.day,e.ts,e.type,e.amount,e.notes,u.name AS by_name FROM expenses e LEFT JOIN users u ON u.id=e.user_id WHERE e.paid_cash=1 AND e.ts>? ORDER BY e.id`).bind(since).all()).results;
    const moves = (await db.prepare(`SELECT c.*, u.name AS by_name FROM cash_moves c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.id DESC LIMIT 30`).all()).results;
    return json({ balance, since, last, sales, expenses, moves });
  }
  if (path === "/cash" && m === "POST") {
    const type = ["recolha", "ajuste", "abertura"].includes(body.type) ? body.type : "recolha";
    if (!mgr) return err("Só a gerência pode registar movimentos de caixa", 403);
    const amount = Math.round(+body.amount || 0);
    if (type !== "ajuste" && !(amount > 0)) return err("Valor inválido");
    await db.prepare(`INSERT INTO cash_moves(ts,day,type,amount,counted,expected,user_id,notes) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(Date.now(), today(), type, amount, body.counted === "" || body.counted == null ? null : Math.round(+body.counted), body.expected == null ? null : Math.round(+body.expected), user.id, (body.notes || "").slice(0, 200)).run();
    // Diferença entre contado e esperado vira ajuste, para o saldo bater com a realidade
    if (type === "recolha" && body.counted != null && body.counted !== "" && body.expected != null) {
      const dif = Math.round(+body.counted) - Math.round(+body.expected);
      if (dif) await db.prepare(`INSERT INTO cash_moves(ts,day,type,amount,user_id,notes) VALUES(?,?,?,?,?,?)`).bind(Date.now() - 1, today(), "ajuste", dif, user.id, "diferença na contagem").run();
    }
    return json({ ok: true });
  }

  // Definições (admin): ex. preço de artigos sem preço
  if (path === "/settings" && m === "PUT") {
    if (!admin) return err("Só o admin", 403);
    const stmts = Object.entries(body || {}).map(([k, v]) => db.prepare(`INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(k, String(v)));
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  // Relatório por período (admin)
  if (path === "/report" && m === "GET") {
    if (!admin) return err("Só o admin", 403);
    const from = url.searchParams.get("from") || today(), to = url.searchParams.get("to") || today();
    const byDay = (await db.prepare(`SELECT day, COUNT(*) n, SUM(subtotal) total, SUM(delivery) delivery FROM sales WHERE void=0 AND day BETWEEN ? AND ? GROUP BY day ORDER BY day`).bind(from, to).all()).results;
    const top = (await db.prepare(`SELECT i.product_id, i.name, SUM(i.qty) qty, SUM(i.qty*i.unit_price) total FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.void=0 AND s.day BETWEEN ? AND ? GROUP BY i.product_id ORDER BY qty DESC LIMIT 20`).bind(from, to).all()).results;
    const bySeller = (await db.prepare(`SELECT u.name, COUNT(*) n, SUM(s.subtotal) total FROM sales s JOIN users u ON u.id=s.user_id WHERE s.void=0 AND s.day BETWEEN ? AND ? GROUP BY u.id ORDER BY total DESC`).bind(from, to).all()).results;
    return json({ from, to, byDay, top, bySeller });
  }

  return err("Rota desconhecida", 404);
}
