'use strict';

const { ADMIN }      = require("./config");
const { agora, log } = require("./utils");
const { wa, tg }     = require("./notificacoes");

// Agenda execucao diaria em horario fixo (reagenda automaticamente apos cada execucao)
function agendar(hora, minuto, nome, fn) {
    const now     = agora();
    let   proximo = now.set({ hour: hora, minute: minuto, second: 0, millisecond: 0 });
    if (proximo <= now) proximo = proximo.plus({ days: 1 });

    const ms = proximo.toMillis() - now.toMillis();

    setTimeout(async () => {
        log("info", `Executando [${nome}]`);
        try { await fn(); }
        catch (e) {
            const msg = `Erro em [${nome}]: ${String(e?.message || e).slice(0, 300)}`;
            log("erro", msg);
            await wa(ADMIN, `*Moodle Monitor*\n${msg}`);
            await tg(`*Moodle Monitor*\n${msg}`);
        }
        agendar(hora, minuto, nome, fn);
    }, ms);
}

// Heartbeat semanal (quarta-feira 10h) — confirma que o bot esta vivo
function agendarHeartbeat() {
    const now     = agora();
    let   proximo = now.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const diasAteQuarta = (3 - now.weekday + 7) % 7;
    proximo = proximo.plus({ days: diasAteQuarta });
    if (proximo <= now) proximo = proximo.plus({ days: 7 });

    const ms = proximo.toMillis() - now.toMillis();
    log("info", `Heartbeat -> ${proximo.toFormat("dd/MM HH:mm")} (em ${Math.round(ms / 60000)} min)`);

    setTimeout(async () => {
        const status = global.botAtivo ? "conectado" : "desconectado";
        await tg(
            `*Moodle Monitor — Heartbeat semanal*\n` +
            `_${agora().toFormat("dd/MM/yyyy HH:mm")}_\n\n` +
            `WhatsApp: ${status}`
        );
        agendarHeartbeat();
    }, ms);
}

module.exports = { agendar, agendarHeartbeat };
