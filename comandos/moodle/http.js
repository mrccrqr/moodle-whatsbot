'use strict';

const https       = require("https");
const http        = require("http");
const querystring = require("querystring");
const { HOST, API_HOST, TG_TOKEN, TG_CHAT_ID } = require("./config");
const { sleep, log } = require("./utils");
const saude          = require("./saude");

// Proxy opcional so para o Moodle (ex.: quando o Moodle bloqueia acesso de fora do Brasil).
// MOODLE_PROXY=socks5://127.0.0.1:1080  -> todo acesso ao Moodle sai pelo proxy; o resto (WhatsApp etc.) nao.
const PROXY        = process.env.MOODLE_PROXY || null;
const agenteMoodle = PROXY ? new (require("socks-proxy-agent").SocksProxyAgent)(PROXY) : undefined;
if (PROXY) log("info", `Acesso ao Moodle via proxy ${PROXY.replace(/\/\/.*@/, "//***@")}`);

// Erros de rede que indicam Moodle inacessivel (o servidor nem respondeu direito)
const ehFalhaDeRede = e => classificarErro(e) === "indispo";

// Classifica erros da API do Moodle para decidir retry/relogin
function classificarErro(e) {
    if (!e) return "outro";
    if (e.tipoFinal) return e.tipoFinal; // erro que ja passou por retry(): mantem a classificacao original
    const code = e?.moodleError?.errorcode || e?.moodleError?.exception || "";
    if (code === "invalidtoken" || code === "accessdenied" || /token/i.test(code)) return "auth";
    if (e?.httpStatus === 401 || e?.httpStatus === 403) return "auth";
    if (
        e?.code === "503"         || e?.code === "TIMEOUT"      ||
        e?.code === "ECONNRESET"  || e?.code === "ECONNREFUSED" || e?.code === "ENOTFOUND" ||
        e?.httpStatus === 502     || e?.httpStatus === 503       || e?.httpStatus === 504 ||
        e?.message?.includes("Timeout") || e?.message?.includes("ECONNRESET")
    ) return "indispo";
    return "outro";
}

// POST form-urlencoded para a API do Moodle
function postForm(caminho, payload, ms = 15000) {
    return new Promise((resolve, reject) => {
        const body = querystring.stringify(payload);
        const req  = https.request({
            hostname: API_HOST, path: caminho, method: "POST", timeout: ms, agent: agenteMoodle,
            headers: {
                "Content-Type":   "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body),
                "User-Agent":    "MoodleMobile 5.1.1 (51100)",
            }
        }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                if ([502, 503, 504].includes(res.statusCode)) {
                    saude.registrarFalha().catch(() => {});
                    return reject(Object.assign(new Error(`Moodle ${res.statusCode}`), { code: "503", httpStatus: res.statusCode }));
                }
                saude.registrarSucesso().catch(() => {});
                if (res.statusCode !== 200 || !(res.headers["content-type"] || "").includes("application/json"))
                    return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { httpStatus: res.statusCode }));
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON invalido: ${e.message}`)); }
            });
        });
        const falhar = e => { if (ehFalhaDeRede(e)) saude.registrarFalha().catch(() => {}); reject(e); };
        req.on("timeout", () => { req.destroy(); falhar(Object.assign(new Error("Timeout"), { code: "TIMEOUT" })); });
        req.on("error", falhar);
        req.write(body); req.end();
    });
}

// Download de arquivo com suporte a redirect
function baixarArquivo(url, redir = 0) {
    return new Promise((resolve, reject) => {
        if (redir > 5) return reject(new Error("Muitos redirecionamentos"));
        const lib = url.startsWith("https") ? https : http;
        const doMoodle = (() => { try { return new URL(url).hostname === HOST; } catch { return false; } })();
        // Arquivo do Moodle: baixa pelo mesmo caminho das chamadas (MOODLE_API_HOST), se configurado
        if (doMoodle && API_HOST !== HOST) { const u = new URL(url); u.hostname = API_HOST; url = u.toString(); }
        lib.get(url, { headers: { "User-Agent": "MoodleMobile 5.1.1 (51100)" }, ...(doMoodle && agenteMoodle ? { agent: agenteMoodle } : {}) }, res => {
            if (res.statusCode === 301 || res.statusCode === 302)
                return baixarArquivo(res.headers.location, redir + 1).then(resolve).catch(reject);
            if (res.statusCode !== 200) {
                res.resume();
                return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { httpStatus: res.statusCode }));
            }
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => resolve({
                buffer:   Buffer.concat(chunks),
                mimetype: res.headers["content-type"] || "application/octet-stream",
            }));
        }).on("error", reject);
    });
}

// Download com retry e renovacao automatica de accessKey
async function baixarArquivoComRetry(fileurl, tentativas = 4) {
    const { obterSiteInfo, urlDownload } = require("./auth");
    let ultimoErro, siteInfoRenovado = false;

    for (let t = 1; t <= tentativas; t++) {
        const url = urlDownload(fileurl);
        if (!url) throw new Error("URL de download invalida");
        try {
            return await baixarArquivo(url);
        } catch (e) {
            ultimoErro = e;
            const tipo = classificarErro(e);
            log("aviso", `Download tentativa ${t}/${tentativas} [${tipo}]: ${e.message}`);
            if (tipo === "auth" && !siteInfoRenovado) {
                siteInfoRenovado = true;
                try { await obterSiteInfo(); log("ok", "accessKey renovado"); }
                catch (er) { log("erro", `Falha ao renovar accessKey: ${er.message}`); }
                continue;
            }
            if (t < tentativas) await sleep(Math.min(2 ** t * 1000, 16000));
        }
    }
    throw ultimoErro ?? new Error("Todas as tentativas de download falharam");
}

// Envia mensagem via Telegram (fallback opcional do WhatsApp)
function telegramPost(text) {
    if (!TG_TOKEN || !TG_CHAT_ID) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "Markdown" });
        const req  = https.request({
            hostname: "api.telegram.org",
            path:     `/bot${TG_TOKEN}/sendMessage`,
            method:   "POST", timeout: 10000,
            headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("Telegram timeout")); });
        req.on("error", reject);
        req.write(body); req.end();
    });
}

module.exports = { classificarErro, postForm, baixarArquivo, baixarArquivoComRetry, telegramPost };
