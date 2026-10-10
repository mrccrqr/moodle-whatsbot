'use strict';

const { ADMIN, TG_TOKEN } = require("./config");
const { sleep, log }      = require("./utils");
const { telegramPost }    = require("./http");

// Telegram: fallback opcional — envia se configurado, ignora silenciosamente se nao
async function tg(texto) {
    if (!TG_TOKEN) return;
    try { await telegramPost(texto); }
    catch (e) { log("erro", "Telegram:", e.message); }
}

// WhatsApp: tenta ate 5x com intervalo. Se falhar, notifica via Telegram
async function wa(jid, texto) {
    for (let t = 1; t <= 5; t++) {
        const bot = global.botAtivo;
        if (!bot) { await sleep(5000); continue; }
        try { await bot.sendMessage(jid, { text: texto, linkPreview: false }); return true; }
        catch { if (t < 5) await sleep(5000); }
    }
    log("erro", `WA falhou para ${jid}.`);
    await tg(`*Moodle Monitor — Falha no WhatsApp*\nDestinatario: \`${jid}\`\n\n${texto.slice(0, 300)}`);
    return false;
}

// Envia arquivo via WhatsApp com retry
async function waArquivo(jid, buffer, mimetype, filename) {
    for (let t = 1; t <= 5; t++) {
        const bot = global.botAtivo;
        if (!bot) { await sleep(5000); continue; }
        try { await bot.sendMessage(jid, { document: buffer, mimetype, fileName: filename }); return true; }
        catch { if (t < 5) await sleep(5000); }
    }
    log("erro", `WA arquivo falhou para ${jid}: ${filename}`);
    await tg(`*Moodle Monitor — Falha no WhatsApp (arquivo)*\nDestinatario: \`${jid}\`\nArquivo: ${filename}`);
    return false;
}

// Broadcast: envia texto para lista de destinos com delay entre envios
async function broadcast(texto, destinos) {
    for (const jid of destinos) { await wa(jid, texto); await sleep(400); }
}

// Broadcast de arquivo para lista de destinos
async function broadcastArquivo(buffer, mimetype, filename, destinos) {
    let falhas = 0;
    for (const jid of destinos) {
        if (!(await waArquivo(jid, buffer, mimetype, filename))) falhas++;
        await sleep(400);
    }
    if (falhas > 0)
        await wa(ADMIN, `*Moodle Monitor*\nFalha ao enviar arquivo para ${falhas} destinatario(s):\n${filename}`);
}

module.exports = { tg, wa, waArquivo, broadcast, broadcastArquivo };
