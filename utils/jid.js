'use strict';

const { variantesNumero, ehGrupo, ehLid } = require("./telefone");

// JID de numero -> JID real no WhatsApp (resolve o nono digito perguntando ao proprio WhatsApp).
// Resultado guardado em memoria; se o WhatsApp nao responder, usa o JID informado.
const resolvidos = new Map();

async function resolverJid(jid) {
    if (!jid || ehGrupo(jid) || ehLid(jid)) return jid;
    if (resolvidos.has(jid)) return resolvidos.get(jid);

    const bot = global.botAtivo;
    if (!bot?.onWhatsApp) return jid;
    try {
        const resp = await bot.onWhatsApp(...variantesNumero(jid));
        const real = resp?.find(r => r.exists)?.jid;
        if (real) { resolvidos.set(jid, real); return real; }
    } catch { /* sem conexao: tenta de novo na proxima */ }
    return jid;
}

module.exports = { resolverJid };
