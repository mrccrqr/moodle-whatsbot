'use strict';

// Acesso ao Moodle: avisa o admin UMA vez quando o bot perde o acesso e UMA vez quando volta.
//
// - Toda chamada ao Moodle (http.js) informa sucesso ou falha de rede aqui.
// - So considera "sem acesso" depois de 30 min seguidos de falhas (instabilidades curtas nao geram aviso).
// - Antes de avisar, testa o Moodle a partir do Brasil (servico publico check-host.net) para dizer com
//   certeza se ele esta FORA DO AR ou se esta no ar mas BLOQUEANDO o servidor do bot (ex.: VPS no exterior).
// - Enquanto esta sem acesso, as verificacoes falham rapido (sem 5 tentativas longas a cada chamada).
// - Quando o acesso volta, roda a recuperacao (confere o que mudou) e avisa o admin.

const https        = require("https");
const { DateTime } = require("luxon");
const { ZONA, ADMIN, HOST } = require("./config");
const { agora, log } = require("./utils");
const { getCache, salvarCache } = require("./cache");

const LIMIAR_S      = 30 * 60; // 30 min seguidos sem resposta = sem acesso
const FALHA_RAPIDA_S = 2 * 60; // depois de 2 min falhando, nao insiste em cada chamada

const agoraS = () => Math.floor(agora().toSeconds());
const fmt    = s => DateTime.fromSeconds(s).setZone(ZONA).toFormat("dd/MM 'às' HH:mm");

function estado() {
    const c = getCache();
    return c._acessoMoodle || (c._acessoMoodle = { falhandoDesde: null, avisado: false });
}

// Ja esta falhando ha algum tempo: as chamadas podem desistir na primeira tentativa
function semAcesso() {
    const e = estado();
    return !!e.falhandoDesde && agoraS() - e.falhandoDesde >= FALHA_RAPIDA_S;
}

let aoVoltarFn = null;
// index.js registra aqui a recuperacao (conferir o que mudou) a rodar quando o acesso voltar
const aoVoltar = fn => { aoVoltarFn = fn; };

// Chamada ao Moodle respondeu
async function registrarSucesso() {
    const e = estado();
    if (!e.falhandoDesde) return;
    const { falhandoDesde, avisado } = e;
    e.falhandoDesde = null; e.avisado = false;
    salvarCache();
    log("ok", `Acesso ao Moodle normalizado (falhando desde ${fmt(falhandoDesde)}).`);
    if (!avisado) return; // instabilidade curta: ninguem foi avisado, nada a dizer
    if (aoVoltarFn) { try { await aoVoltarFn(); } catch (err) { log("erro", `Recuperacao apos acesso voltar: ${err.message}`); } }
    await enviarAdmin(`O acesso ao Moodle voltou. Fiquei sem acesso de ${fmt(falhandoDesde)} até ${fmt(agoraS())}. Já conferi o que mudou nesse período.`);
}

// Chamada ao Moodle nao respondeu (timeout, conexao recusada, 502/503/504)
async function registrarFalha() {
    const e = estado();
    if (!e.falhandoDesde) { e.falhandoDesde = agoraS(); salvarCache(); return; }
    if (e.avisado || agoraS() - e.falhandoDesde < LIMIAR_S) return;
    e.avisado = true; // marca antes do diagnostico (que demora) para nao avisar duas vezes
    salvarCache();

    const doBrasil = await module.exports.testarDoBrasil(); // via exports: substituivel nos testes
    const desde = fmt(e.falhandoDesde);
    let msg;
    if (doBrasil === "ok")
        msg = `Não consigo acessar o Moodle desde ${desde}, mas ele está no ar: testei a partir do Brasil e respondeu normalmente. ` +
              `O Moodle está bloqueando o acesso do servidor do bot.` +
              (process.env.MOODLE_PROXY ? ` A saída pelo proxy (MOODLE_PROXY) também não está funcionando.` : ` Dá para contornar com MOODLE_PROXY (ver README).`) +
              ` Aviso aqui quando o acesso voltar.`;
    else if (doBrasil === "falha")
        msg = `O Moodle está fora do ar desde ${desde} (não responde nem a partir do Brasil). Aviso aqui quando voltar.`;
    else
        msg = `Não consigo acessar o Moodle desde ${desde}. Não consegui confirmar se ele está fora do ar ou bloqueando o servidor do bot. Aviso aqui quando voltar.`;
    log("aviso", msg);
    await enviarAdmin(msg);
}

async function enviarAdmin(texto) {
    const { wa } = require("./notificacoes"); // tardio: notificacoes -> http -> saude
    await wa(ADMIN, texto);
}

// ------------------------------------------------------------------ teste a partir do Brasil

function getJson(url, ms = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { Accept: "application/json" }, timeout: ms }, res => {
            let d = ""; res.on("data", c => d += c);
            res.on("end", () => { try { resolve(JSON.parse(d)); } catch (err) { reject(err); } });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
    });
}

// "ok" se o Moodle responde a partir de Sao Paulo, "falha" se nao responde, null se nao deu para testar
async function testarDoBrasil() {
    try {
        const no = "br1.node.check-host.net";
        const { request_id } = await getJson(`https://check-host.net/check-tcp?host=${HOST}:443&node=${no}`);
        for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const r = (await getJson(`https://check-host.net/check-result/${request_id}`))[no];
            if (Array.isArray(r) && r[0]) return r[0].time != null ? "ok" : "falha";
        }
    } catch (err) { log("aviso", `Teste do Moodle a partir do Brasil indisponivel: ${err.message}`); }
    return null;
}

module.exports = { registrarSucesso, registrarFalha, semAcesso, aoVoltar, testarDoBrasil };
