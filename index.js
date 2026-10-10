require("dotenv").config({ quiet: true });
require("./utils/silenciarSignal");
const { default: criarSocket, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { iniciarAutenticacao } = require("./utils/autenticacao");
const { verificarMoodle }     = require("./utils/verificarMoodle");
const qrTerminal = require("qrcode-terminal");
const fs   = require("fs");
const path = require("path");

let botWhatsApp = null;

// Logger silencioso para o Baileys (evita despejar JSON no terminal)
const loggerSilencioso = {
    level: "silent",
    child: () => loggerSilencioso,
    trace() {}, debug() {}, info() {}, warn() {}, error() {},
};

// Comandos da pasta comandos/ (arquivos .js e pastas com index.js).
// Carregados so apos a verificacao do Moodle, pois alguns modulos exigem o moodle/.env valido.
const comandos = [];
function carregarComandos() {
    fs.readdirSync(path.join(__dirname, "comandos")).forEach(entry => {
        const fullPath = path.join(__dirname, "comandos", entry);
        if (fs.statSync(fullPath).isDirectory() || entry.endsWith(".js"))
            comandos.push(require(fullPath));
    });
}

// Detecta envelopes sem texto (edicao, reacao, voto) que nao devem ser processados
const ehEnvelopeSemTexto = m => !!(
    m?.protocolMessage || m?.editedMessage ||
    m?.secretEncryptedMessage || m?.reactionMessage || m?.pollUpdateMessage
);

const ehEdicao = m => !!(
    m?.secretEncryptedMessage || m?.protocolMessage?.editedMessage || m?.editedMessage
);

process.on('uncaughtException',  err    => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));

async function iniciarWhatsApp() {
    const { state, saveCreds } = await iniciarAutenticacao();
    const { version } = await fetchLatestBaileysVersion();
    botWhatsApp = criarSocket({ version, auth: state, logger: loggerSilencioso });
    global.botAtivo = botWhatsApp;

    botWhatsApp.ev.on("creds.update", saveCreds);

    botWhatsApp.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) { console.log("[QR] Escaneie o QR code abaixo:"); qrTerminal.generate(qr, { small: true }); }
        if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== 401) iniciarWhatsApp();
        if (connection === "open") console.log("[BOT] Conectado ao WhatsApp.");
    });

    // Bot adicionado a um grupo: avisa os modulos interessados (ex.: comandos/destinos.js)
    botWhatsApp.ev.on("groups.upsert", async grupos => {
        for (const cmd of comandos)
            if (typeof cmd.onGrupoNovo === "function")
                for (const g of grupos) {
                    try { await cmd.onGrupoNovo({ botWhatsApp, grupo: g, lote: grupos.length }); }
                    catch (err) { console.error(`[onGrupoNovo] Erro no modulo ${cmd.nome || "?"}:`, err); }
                }
    });

    botWhatsApp.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || !msg.key.remoteJid) return;
        if (msg.key.fromMe) return;
        if (msg.key.remoteJid === "status@broadcast") return;

        const jid = msg.key.remoteJid;
        if (jid.endsWith("@g.us")) return; // ignora mensagens de grupo (comandos sao so no privado)

        const jidUsuario  = msg.key.participant || msg.key.remoteJid;
        const nomeUsuario = msg.pushName || jidUsuario;
        const texto       = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const textoLower  = texto.trim().toLowerCase();

        try { await botWhatsApp.readMessages([msg.key]); } catch {}

        // Mensagem editada: avisa que nao consegue ler
        if (ehEnvelopeSemTexto(msg.message)) {
            if (ehEdicao(msg.message)) {
                const falta = comandos.map(c => c.aguardandoOQue?.(jidUsuario)).find(Boolean);
                if (falta) {
                    try {
                        await botWhatsApp.sendMessage(jid, {
                            text: `Vi que voce editou a mensagem, mas nao consigo ler edicoes. Me manda ${falta} numa mensagem nova?`,
                            linkPreview: false,
                        });
                    } catch {}
                }
            }
            return;
        }

        // 1. Oferece a mensagem a modulos que estejam aguardando resposta
        for (const cmd of comandos) {
            if (typeof cmd.onMensagem === "function") {
                try {
                    if (await cmd.onMensagem({ texto, textoLower, jid, jidUsuario, nomeUsuario, msg })) return;
                } catch (err) {
                    console.error(`[onMensagem] Erro no modulo ${cmd.nome || "?"}:`, err);
                }
            }
        }

        // 2. Tenta casar com algum comando via match()
        for (const cmd of comandos) {
            if (typeof cmd.match === "function" && cmd.match(textoLower, jidUsuario)) {
                try {
                    await cmd.executar({ botWhatsApp, jid, jidUsuario, nomeUsuario, texto, textoLower, msg });
                } catch (err) {
                    console.error(`[executar] Erro no modulo ${cmd.nome || "?"}:`, err);
                    try { await botWhatsApp.sendMessage(jid, { text: "Ocorreu um erro ao processar o comando.", linkPreview: false }); } catch {}
                }
                break;
            }
        }
    });
}

(async () => {
    if (!(await verificarMoodle())) process.exit(1);
    try { carregarComandos(); }
    catch (e) { console.error(`[ERRO] ${e.message}`); process.exit(1); }
    iniciarWhatsApp();
})();
