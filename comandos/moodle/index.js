'use strict';

const { DateTime }               = require("luxon");
const { log, sleep, agora }      = require("./utils");
const { getCache, salvarCache }  = require("./cache");
const { tg, wa }                 = require("./notificacoes");
const { ADMIN, ZONA }            = require("./config");
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

    await recuperar(getCache()._vivoEm);

    for (const [h, m, nome, fn] of AGENDA) agendar(h, m, nome, fn);
    log("ok", `${AGENDA.length} verificacoes agendadas por dia.`);
    agendarHeartbeat();
    setInterval(pulso, PULSO_MS);
}, 1000);

// --- Saber quando o bot ficou fora do ar ---
// A cada 5 min o bot marca "estou vivo" no cache. Ao iniciar, ou ao voltar de uma pausa (computador
// suspenso, processo travado), se a ultima marca tem mais de 2h ele confere tudo o que mudou e avisa o admin.
const PULSO_MS   = 5 * 60 * 1000;
const AUSENCIA_S = 2 * 3600;
let recuperando  = false;

const marcarVivo = () => { getCache()._vivoEm = Math.floor(agora().toSeconds()); salvarCache(); };
const fmtMomento = s => DateTime.fromSeconds(s).setZone(ZONA).toFormat("dd/MM HH:mm");

// Roda as verificacoes de "ao iniciar" (conteudo novo e avisos do dia que ja passaram) e,
// se o bot estava fora havia mais de 2h, avisa o admin.
async function recuperar(ultimoVivo) {
    if (recuperando) return;
    recuperando = true;
    try {
        for (const [nome, fn, aPartirDe] of AO_INICIAR) {
            if (agora().hour < aPartirDe) continue;
            try { await fn(); }
            catch (e) { log("erro", `[${nome}] na recuperacao: ${e.message}`); }
        }
        const agoraS = Math.floor(agora().toSeconds());
        if (ultimoVivo && agoraS - ultimoVivo > AUSENCIA_S) {
            log("aviso", `Bot ficou fora do ar de ${fmtMomento(ultimoVivo)} ate ${fmtMomento(agoraS)}.`);
            await wa(ADMIN, `Fiquei fora do ar de ${fmtMomento(ultimoVivo)} até ${fmtMomento(agoraS)}. Já conferi tudo que mudou no Moodle nesse período.`);
        }
        marcarVivo();
    } finally { recuperando = false; }
}

// Pulso periodico: se o intervalo desde a ultima marca for grande, o processo esteve parado -> recupera
async function pulso() {
    const ultimo = getCache()._vivoEm;
    if (ultimo && Math.floor(agora().toSeconds()) - ultimo > AUSENCIA_S) await recuperar(ultimo);
    else marcarVivo();
}

module.exports = {
    nome:     "moodle",
    match:    () => false,
    executar: async () => {},
};
