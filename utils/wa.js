'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Envia mensagem via WhatsApp com ate 3 tentativas
async function enviar(jid, texto) {
    for (let t = 1; t <= 3; t++) {
        const bot = global.botAtivo;
        if (!bot) { await sleep(3000); continue; }
        try {
            await bot.sendMessage(jid, { text: texto, linkPreview: false });
            return true;
        } catch {
            if (t < 3) await sleep(3000);
        }
    }
    return false;
}

module.exports = { enviar };
