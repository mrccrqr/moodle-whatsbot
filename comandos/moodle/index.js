'use strict';

const { log, sleep }             = require("./utils");
const { tg, wa }                 = require("./notificacoes");
const { ADMIN }                  = require("./config");
const { classificarErro }        = require("./http");
const { obterSiteInfo, relogin } = require("./auth");
const { popularCacheInicial, verificarNovas, verificarModulos, verificarAvisos, verificarAtualizacoes, verificarVencimentos, verificarLinks, verificarForuns, verificarAulasHoje } = require("./verificacoes");
const { agendar, agendarHeartbeat } = require("./agendamento");

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

    await popularCacheInicial();

    agendar(6,  0, "Novas atividades",  verificarNovas);
    for (const h of [6, 9, 12, 15, 18, 21]) {
        agendar(h, 5,  `Novos modulos ${h}h`, verificarModulos);
        agendar(h, 10, `Avisos ${h}h`,        verificarAvisos);
    }
    agendar(10, 0, "Atualizacoes",      verificarAtualizacoes);
    agendar(12, 0, "Vencimentos",       verificarVencimentos);
    agendar(14, 0, "Foruns do dia",     verificarForuns);
    agendar(15, 0, "Links de aulas",    verificarLinks);
    agendar(18, 0, "Aulas do dia",      verificarAulasHoje);
    agendar(19, 0, "Aulas do dia 19h",  verificarAulasHoje);
    agendar(20, 0, "Aulas do dia 20h",  verificarAulasHoje);
    agendarHeartbeat();
}, 1000);

module.exports = {
    nome:     "moodle",
    match:    () => false,
    executar: async () => {},
};
