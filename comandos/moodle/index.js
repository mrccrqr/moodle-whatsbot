'use strict';

const { log, sleep, agora }      = require("./utils");
const { tg, wa }                 = require("./notificacoes");
const { ADMIN }                  = require("./config");
const { classificarErro }        = require("./http");
const { obterSiteInfo, relogin } = require("./auth");
const { agendar, agendarHeartbeat } = require("./agendamento");
const { AGENDA, AO_INICIAR }     = require("./rotina");

const BACKOFF_INDISPO = [2, 4, 8, 16, 30]; // minutos — trava em 30min

// Aguarda o Moodle ficar disponivel antes de iniciar verificacoes
async function aguardarMoodle() {
    let tentativa = 0;
    while (true) {
        try {
            await obterSiteInfo();
            if (tentativa > 0) {
                const msg = `*Moodle Monitor*\nMoodle voltou ao ar apos ${tentativa} tentativa(s).`;
                log("ok", "Moodle voltou!");
                await Promise.all([tg(msg), wa(ADMIN, msg)]);
            } else {
                log("ok", "SiteInfo OK");
            }
            return;
        } catch (e) {
            const tipo = classificarErro(e);

            if (tipo === "auth") {
                log("aviso", `SiteInfo falhou por auth (${e.message}), tentando relogin...`);
                try { await relogin(); log("ok", "Relogin OK"); return; }
                catch (er) {
                    const msg = `*Moodle Monitor*\nFalha de autenticacao:\n\`${er.message}\`\n\nVerifique as credenciais no .env e reinicie.`;
                    log("erro", `Relogin falhou: ${er.message}`);
                    await Promise.all([tg(msg), wa(ADMIN, msg)]);
                    throw er;
                }
            }

            const minutos = BACKOFF_INDISPO[Math.min(tentativa, BACKOFF_INDISPO.length - 1)];
            if (tentativa === 0) {
                const msg = `*Moodle Monitor*\nMoodle parece estar fora do ar. Tentando a cada ${minutos}min.`;
                log("aviso", `Moodle indisponivel (${e.message}).`);
                await Promise.all([tg(msg), wa(ADMIN, msg)]);
            } else {
                log("aviso", `Moodle ainda fora — tentativa ${tentativa + 1}, proxima em ${minutos}min`);
            }
            tentativa++;
            await sleep(minutos * 60 * 1000);
        }
    }
}

// Espera o bot do WhatsApp estar pronto, depois inicializa tudo
const aguardandoBot = setInterval(async () => {
    if (!global.botAtivo) return;
    clearInterval(aguardandoBot);
    log("ok", "Bot detectado, inicializando...");

    try { await aguardarMoodle(); }
    catch { return; }

    for (const [nome, fn, aPartirDe] of AO_INICIAR) {
        if (agora().hour < aPartirDe) continue;
        try { await fn(); }
        catch (e) { log("erro", `[${nome}] na inicializacao: ${e.message}`); }
    }

    for (const [h, m, nome, fn] of AGENDA) agendar(h, m, nome, fn);
    log("ok", `${AGENDA.length} verificacoes agendadas por dia.`);
    agendarHeartbeat();
}, 1000);

module.exports = {
    nome:     "moodle",
    match:    () => false,
    executar: async () => {},
};
