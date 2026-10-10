'use strict';

const { resolverJid } = require("./jid");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Envia mensagem via WhatsApp com ate 3 tentativas
async function enviar(jid, texto) {
    jid = await resolverJid(jid); // resolve o nono digito
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

// Tempo de "digitando..." proporcional ao tamanho do texto (entre 0,7s e 2s).
// DIGITANDO_MS fixa o tempo (os testes usam 0 para nao esperar).
const tempoDigitando = texto => process.env.DIGITANDO_MS !== undefined
    ? Number(process.env.DIGITANDO_MS)
    : Math.min(2000, Math.max(700, 400 + texto.length * 25));

// Envia varias mensagens em sequencia, cada uma com o efeito "digitando..." antes.
// Cada envio so comeca depois que o anterior terminou, entao a ordem e garantida.
async function enviarDigitando(jid, textos) {
    jid = await resolverJid(jid);
    const bot = global.botAtivo;
    for (const texto of textos) {
        try { await bot.sendPresenceUpdate("composing", jid); } catch {}
        await sleep(tempoDigitando(texto));
        try { await bot.sendPresenceUpdate("paused", jid); } catch {}
        if (!(await enviar(jid, texto))) return false;
    }
    return true;
}

module.exports = { enviar, enviarDigitando, tempoDigitando };
