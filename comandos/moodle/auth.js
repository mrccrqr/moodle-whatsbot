'use strict';

const { HOST, estado, definirNoEnv }              = require("./config");
const { sleep, log }                              = require("./utils");
const { classificarErro, postForm, telegramPost } = require("./http");

// Salva o token no moodle/.env para sobreviver a reinicializacoes
function salvarTokenNoEnv(novoToken) {
    try {
        // Grava o token junto com o usuario dono dele (ver config.js)
        definirNoEnv("MOODLE_TOKEN_USER", process.env.MOODLE_USER || "");
        definirNoEnv("MOODLE_TOKEN", novoToken);
        log("ok", "Token persistido no .env com sucesso.");
    } catch (e) {
        log("erro", `Falha ao persistir token: ${e.message}`);
    }
}

// Converte URL de arquivo do Moodle para URL autenticada via accessKey
function urlDownload(fileurl) {
    try {
        const partes = new URL(fileurl).pathname.split("/").filter(Boolean).slice(2);
        return `https://${HOST}/tokenpluginfile.php/${estado.accessKey}/${partes.join("/")}?offline=1&lang=pt_br`;
    } catch { return null; }
}

// Obtem informacoes do site e accessKey para downloads
async function obterSiteInfo() {
    const res = await postForm("/webservice/rest/server.php?moodlewsrestformat=json", {
        wsfunction: "core_webservice_get_site_info",
        wstoken:    estado.wsToken,
    });
    if (res.exception || res.errorcode)
        throw Object.assign(new Error(res.message || "Erro no siteInfo"), { moodleError: res });
    if (!res.userprivateaccesskey)
        throw new Error("userprivateaccesskey ausente na resposta");
    estado.accessKey = res.userprivateaccesskey;
    estado.userId    = res.userid;
}

// Faz login e obtem novo token automaticamente
async function relogin() {
    log("aviso", "Renovando token de autenticacao...");
    const res = await postForm("/login/token.php?lang=pt_br", {
        username: process.env.MOODLE_USER,
        password: process.env.MOODLE_PASS,
        service:  "moodle_mobile_app",
    });
    if (!res.token) {
        const credencialInvalida = res?.errorcode === "invalidlogin";
        throw Object.assign(
            new Error(`Relogin falhou: ${JSON.stringify(res).slice(0, 150)}`),
            { credencialInvalida }
        );
    }
    estado.wsToken = res.token;
    salvarTokenNoEnv(estado.wsToken);
    await obterSiteInfo();
    log("ok", "Token renovado com sucesso.");
    await telegramPost(`*Moodle Monitor* — Token renovado.`).catch(() => {});
}

// Executa funcao com retry automatico, relogin em erro de auth
async function retry(fn, tentativas = 5) {
    let reloginFeito = false;
    for (let t = 1; t <= tentativas; t++) {
        try { return await fn(); }
        catch (e) {
            const tipo = classificarErro(e);

            if (tipo === "auth" && !reloginFeito) {
                reloginFeito = true;
                log("aviso", `Tentativa ${t}: erro de auth, relogando...`);
                try { await relogin(); }
                catch (er) {
                    log("erro", `Relogin falhou: ${er.message}`);
                    await telegramPost(`*Moodle Monitor*\nRelogin falhou:\n\`${er.message}\``).catch(() => {});
                    if (er.credencialInvalida) throw new Error(`Credenciais invalidas: ${er.message}`);
                }
                continue;
            }

            if (t === tentativas) {
                const motivo = tipo === "indispo" ? "Moodle pode estar fora do ar"
                    : tipo === "auth" ? "Falha de autenticacao persistente"
                    : e?.message || "erro desconhecido";
                throw Object.assign(
                    new Error(`${tentativas} tentativas falharam — ${motivo}`),
                    { tipoFinal: tipo, causaOriginal: e }
                );
            }

            const backoff = tipo === "indispo"
                ? Math.min(2 ** t * 5000, 30 * 60 * 1000)
                : Math.min(2 ** t * 1000, 32000);
            log("aviso", `Tentativa ${t}/${tentativas} [${tipo}]: ${e?.message || e}`);
            await sleep(backoff);
        }
    }
}

module.exports = { salvarTokenNoEnv, urlDownload, obterSiteInfo, relogin, retry };
