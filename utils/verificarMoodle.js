'use strict';

const path  = require("path");
const https = require("https");
const querystring = require("querystring");

const ENV_PATH = path.join(__dirname, "../moodle/.env");

// Carrega moodle/.env sem poluir o terminal
require("dotenv").config({ path: ENV_PATH, quiet: true });

const { configAcesso } = require("./acessoMoodle");

function tentarLogin(host, usuario, senha, agente) {
    return new Promise((resolve, reject) => {
        const body = querystring.stringify({ username: usuario, password: senha, service: "moodle_mobile_app" });
        const req = https.request({
            hostname: host, path: "/login/token.php?lang=pt_br", method: "POST", timeout: 15000, agent: agente,
            headers: {
                "Content-Type":   "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body),
                "User-Agent":     "MoodleMobile 5.1.1 (51100)",
            },
        }, res => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`resposta invalida (HTTP ${res.statusCode})`)); } });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("tempo esgotado")); });
        req.on("error", reject);
        req.write(body); req.end();
    });
}

// Testa as credenciais do Moodle antes de iniciar o WhatsApp.
// Retorna true se pode prosseguir, false se deve abortar.
async function verificarMoodle() {
    // Mesmo caminho que o bot usa para chegar ao Moodle (direto, repasse ou proxy; ver docs/REPASSE.md)
    let acesso;
    try { acesso = configAcesso(); }
    catch (e) { console.error(`[ERRO] ${e.message}`); return false; }
    const usuario = (process.env.MOODLE_USER || "").trim();
    const senha   = process.env.MOODLE_PASS || "";

    const faltando = [];
    if (!usuario) faltando.push("MOODLE_USER");
    if (!senha)   faltando.push("MOODLE_PASS");
    if (faltando.length) {
        console.error(`[ERRO] Preencha ${faltando.join(" e ")} no arquivo moodle/.env`);
        return false;
    }

    console.log(`[MOODLE] Verificando credenciais${acesso.modo === "direto" ? "" : ` (acesso ${acesso.descricao})`}...`);
    try {
        const res = await tentarLogin(acesso.apiHost, usuario, senha, acesso.agente);
        if (res.token) { console.log("[MOODLE] Autenticado com sucesso."); return true; }
        if (res.errorcode === "invalidlogin") {
            console.error("[ERRO] Usuario ou senha do Moodle incorretos. Corrija MOODLE_USER/MOODLE_PASS em moodle/.env");
            return false;
        }
        console.error(`[ERRO] Moodle recusou o login: ${res.error || res.errorcode || "motivo desconhecido"}`);
        return false;
    } catch (e) {
        // Moodle fora do ar/sem rede: nao e problema de credencial, o modulo moodle ja tem retry
        console.warn(`[AVISO] Nao foi possivel contatar o Moodle (${e.message}). Continuando mesmo assim.`);
        return true;
    }
}

module.exports = { verificarMoodle };
