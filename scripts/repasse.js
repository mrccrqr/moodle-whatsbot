#!/usr/bin/env node
'use strict';

// Repasse no Brasil para o Moodle (API Gateway HTTP API da AWS). Ver docs/REPASSE.md.
//
//   npm run repasse -- status                 mostra o modo atual e testa o acesso direto e pelo repasse
//   npm run repasse -- criar                  cria (ou reaproveita) o repasse na SUA conta AWS, testa e grava no .env
//   npm run repasse -- desligar               volta para acesso direto (MOODLE_ACESSO=direto), sem apagar nada
//   npm run repasse -- ligar                  volta a usar o repasse ja configurado
//   npm run repasse -- remover --confirmar    apaga o repasse da AWS e volta para acesso direto
//
// Opcoes: --regiao sa-east-1   --nome moodle-whatsbot-repasse   --env caminho/do/.env
//
// Requer a AWS CLI instalada e configurada (aws configure) com permissao de API Gateway. As chaves da AWS
// so sao usadas aqui, na criacao: o bot nao precisa delas, so do endereco gravado em MOODLE_REPASSE_URL.

const fs            = require("fs");
const path          = require("path");
const https         = require("https");
const { execFileSync } = require("child_process");
const { limparHost } = require("../utils/acessoMoodle");

const args   = process.argv.slice(2);
const acao   = args.find(a => !a.startsWith("--")) || "status";
const opcao  = (nome, padrao) => { const i = args.indexOf(`--${nome}`); return i >= 0 && args[i + 1] ? args[i + 1] : padrao; };
const REGIAO = opcao("regiao", "sa-east-1");
const NOME   = opcao("nome", "moodle-whatsbot-repasse");
const ENV    = path.resolve(opcao("env", path.join(__dirname, "..", "moodle", ".env")));

// ------------------------------------------------------------------ .env

function lerEnv() {
    const txt = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
    return Object.fromEntries(txt.split(/\r?\n/).map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
}

function gravarEnv(chave, valor) {
    let txt = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
    const re = new RegExp(`^${chave}=.*$`, "m");
    txt = re.test(txt) ? txt.replace(re, `${chave}=${valor}`) : `${txt.replace(/\s*$/, "")}\n${chave}=${valor}\n`;
    fs.writeFileSync(ENV, txt, "utf8");
}

// ------------------------------------------------------------------ AWS CLI

function caminhoAws() {
    const candidatos = [process.env.AWS_CLI, "aws",
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Amazon", "AWSCLIV2", "aws.exe"),
        "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe"].filter(Boolean);
    for (const c of candidatos) { try { execFileSync(c, ["--version"], { stdio: "ignore" }); return c; } catch {} }
    throw new Error("AWS CLI nao encontrada. Instale (https://aws.amazon.com/cli/) e rode: aws configure");
}

let AWS = null;
function aws(...params) {
    AWS ||= caminhoAws();
    const saida = execFileSync(AWS, [...params, "--region", REGIAO, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return saida.trim() ? JSON.parse(saida) : null;
}

const acharApi = () => (aws("apigatewayv2", "get-apis").Items || []).find(a => a.Name === NOME) || null;
const endereco = api => `https://${api.ApiId}.execute-api.${REGIAO}.amazonaws.com`;

// ------------------------------------------------------------------ teste de acesso

function testar(host, ms = 20000) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const req = https.get({ hostname: host, path: "/login/index.php", timeout: ms, headers: { "User-Agent": "moodle-whatsbot" } }, res => {
            res.resume();
            resolve({ ok: res.statusCode < 500, detalhe: `HTTP ${res.statusCode} em ${((Date.now() - t0) / 1000).toFixed(1)}s` });
        });
        req.on("timeout", () => { req.destroy(); resolve({ ok: false, detalhe: "sem resposta (timeout)" }); });
        req.on("error", e => resolve({ ok: false, detalhe: e.code || e.message }));
    });
}

// ------------------------------------------------------------------ acoes

async function status() {
    const env  = lerEnv();
    const host = limparHost(env.MOODLE_HOST) || "moodle4.uesb.br";
    const url  = env.MOODLE_REPASSE_URL || env.MOODLE_API_HOST || "";
    const modo = (env.MOODLE_ACESSO || (url ? "repasse" : env.MOODLE_PROXY ? "proxy" : "direto")).toLowerCase();
    console.log(`Arquivo:          ${ENV}`);
    console.log(`Modo atual:       MOODLE_ACESSO=${modo}`);
    console.log(`Moodle:           ${host}`);
    console.log(`Repasse:          ${url || "(nenhum)"}`);
    const direto = await testar(host);
    console.log(`Acesso direto:    ${direto.ok ? "OK" : "FALHOU"} (${direto.detalhe})`);
    if (url) {
        const r = await testar(limparHost(url));
        console.log(`Pelo repasse:     ${r.ok ? "OK" : "FALHOU"} (${r.detalhe})`);
    }
    if (!direto.ok && modo === "direto")
        console.log("\nO acesso direto falhou. Se o Moodle bloqueia este servidor, crie um repasse: npm run repasse -- criar");
}

async function criar() {
    const env  = lerEnv();
    const host = limparHost(env.MOODLE_HOST) || "moodle4.uesb.br";
    const conta = aws("sts", "get-caller-identity");
    console.log(`Conta AWS: ${conta.Arn}  |  regiao: ${REGIAO}  |  Moodle: ${host}`);

    let api = acharApi();
    if (api) console.log(`Repasse "${NOME}" ja existe: reaproveitando (${api.ApiId}).`);
    else {
        api = aws("apigatewayv2", "create-api", "--name", NOME, "--protocol-type", "HTTP",
            "--description", `Repasse do moodle-whatsbot para ${host}`, "--tags", "projeto=moodle-whatsbot");
        const integ = aws("apigatewayv2", "create-integration", "--api-id", api.ApiId, "--integration-type", "HTTP_PROXY",
            "--integration-method", "ANY", "--integration-uri", `https://${host}/{proxy}`,
            "--payload-format-version", "1.0", "--timeout-in-millis", "29000");
        aws("apigatewayv2", "create-route", "--api-id", api.ApiId, "--route-key", "ANY /{proxy+}", "--target", `integrations/${integ.IntegrationId}`);
        // Limite de 5 req/s: o bot faz ~200 por dia; o limite so evita custo se alguem descobrir o endereco
        aws("apigatewayv2", "create-stage", "--api-id", api.ApiId, "--stage-name", "$default", "--auto-deploy",
            "--default-route-settings", "ThrottlingBurstLimit=10,ThrottlingRateLimit=5");
        console.log(`Repasse criado: ${api.ApiId}`);
        await new Promise(r => setTimeout(r, 5000)); // a AWS leva alguns segundos para publicar
    }

    const url = endereco(api);
    const t = await testar(limparHost(url), 30000);
    console.log(`Teste pelo repasse: ${t.ok ? "OK" : "FALHOU"} (${t.detalhe})`);
    if (!t.ok) {
        console.log("O Moodle nao respondeu pelo repasse. Nada foi alterado no .env. Para apagar: npm run repasse -- remover --confirmar");
        process.exitCode = 1;
        return;
    }
    gravarEnv("MOODLE_REPASSE_URL", url);
    gravarEnv("MOODLE_ACESSO", "repasse");
    console.log(`\nGravado em ${ENV}:\n  MOODLE_ACESSO=repasse\n  MOODLE_REPASSE_URL=${url}\nReinicie o bot para valer.`);
}

function alternar(modo) {
    if (modo === "repasse" && !(lerEnv().MOODLE_REPASSE_URL || lerEnv().MOODLE_API_HOST))
        throw new Error("Nenhum repasse configurado. Crie com: npm run repasse -- criar");
    gravarEnv("MOODLE_ACESSO", modo);
    console.log(`MOODLE_ACESSO=${modo} gravado em ${ENV}. Reinicie o bot para valer.`);
}

function remover() {
    if (!args.includes("--confirmar")) {
        console.log(`Isto apaga o repasse "${NOME}" da AWS (${REGIAO}) e volta o bot para acesso direto.\nPara confirmar: npm run repasse -- remover --confirmar`);
        return;
    }
    const api = acharApi();
    if (api) { aws("apigatewayv2", "delete-api", "--api-id", api.ApiId); console.log(`Repasse ${api.ApiId} apagado da AWS.`); }
    else console.log(`Nenhum repasse "${NOME}" encontrado em ${REGIAO}.`);
    gravarEnv("MOODLE_ACESSO", "direto");
    console.log(`MOODLE_ACESSO=direto gravado em ${ENV}. Reinicie o bot para valer.`);
}

const acoes = { status, criar, remover, ligar: () => alternar("repasse"), desligar: () => alternar("direto") };
if (!acoes[acao]) { console.error(`Acao desconhecida: ${acao}. Use: status, criar, ligar, desligar, remover`); process.exit(1); }
Promise.resolve(acoes[acao]()).catch(e => {
    const msg = String(e.stderr || e.message || e).trim();
    console.error(`[ERRO] ${msg.split("\n").slice(-3).join(" ")}`);
    process.exit(1);
});
