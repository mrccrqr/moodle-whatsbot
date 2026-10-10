// Diagnostico do WhatsApp: conecta com a sessao do bot (pasta auth/), mostra a conta conectada,
// resolve o numero do admin (com e sem o nono digito) e lista os grupos com nome e ID.
//
// uso:
//   npm run whatsapp                      -> diagnostico (pareia por QR se ainda nao houver sessao)
//   npm run whatsapp -- parear 77991234567  -> pareia pelo codigo de 8 letras (numero da conta do BOT)
//   npm run whatsapp -- enviar            -> tambem manda uma mensagem de teste ao admin, pelo mesmo caminho do bot
//
// Pare o bot (npm start) antes: duas conexoes com a mesma sessao derrubam uma a outra.

process.env.MOODLE_USER ||= "-"; process.env.MOODLE_PASS ||= "-"; // config.js nao precisa do Moodle aqui

require("../utils/silenciarSignal");
const { default: criarSocket, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const qrTerminal = require("qrcode-terminal");
const { iniciarAutenticacao, AUTH_DIR } = require("../utils/autenticacao");
const { variantesNumero } = require("../utils/telefone");
const { resolverJid }     = require("../utils/jid");
const { ADMIN, DESTINOS_GRUPO, DESTINOS_PESSOAL } = require("../comandos/moodle/config");

const [modo, numeroBot] = process.argv.slice(2);
const silencioso = { level: "silent", child: () => silencioso, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const esperar = ms => new Promise(r => setTimeout(r, ms));

async function conectar() {
    const { state, saveCreds } = await iniciarAutenticacao();
    const { version } = await fetchLatestBaileysVersion();
    const sock = criarSocket({ version, auth: state, logger: silencioso });
    sock.ev.on("creds.update", saveCreds);
    let pediuCodigo = false;

    return new Promise((resolve, reject) => {
        sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
            if (qr && !state.creds.registered) {
                if (modo === "parear" && numeroBot && !pediuCodigo) {
                    pediuCodigo = true;
                    const codigo = await sock.requestPairingCode(variantesNumero(numeroBot)[0]);
                    console.log(`\nCODIGO DE PAREAMENTO: ${codigo}\nNo celular do bot: WhatsApp > Aparelhos conectados > Conectar aparelho > Conectar com numero de telefone.\n`);
                } else if (modo !== "parear") {
                    console.log("\nEscaneie o QR com o WhatsApp da conta do BOT (Aparelhos conectados):");
                    qrTerminal.generate(qr, { small: true });
                }
            }
            if (connection === "open") resolve(sock);
            if (connection === "close") {
                const codigo = lastDisconnect?.error?.output?.statusCode;
                // Logo apos parear o WhatsApp pede para reconectar (restartRequired): reconecta uma vez
                if (codigo === DisconnectReason.restartRequired) return resolve(conectar());
                reject(new Error(`conexao fechada (codigo ${codigo})`));
            }
        });
    });
}

(async () => {
    console.log(`Sessao: ${AUTH_DIR}`);
    const sock = await conectar();
    global.botAtivo = sock; // resolverJid usa a conexao ativa, como no bot
    const me = sock.user || {};
    console.log(`\n== CONTA DO BOT\n   id: ${me.id}\n   lid: ${me.lid || "-"}\n   nome: ${me.name || "-"}`);

    console.log(`\n== ADMIN (.env): ${ADMIN}`);
    const variantes = variantesNumero(ADMIN);
    for (const v of variantes) {
        const r = await sock.onWhatsApp(v).catch(e => [{ erro: e.message }]);
        console.log(`   ${v.padEnd(14)} -> ${r?.[0]?.erro ? "erro: " + r[0].erro : r?.[0]?.exists ? `EXISTE, id real: ${r[0].jid}` : "nao existe"}`);
    }
    const mesmoQueBot = variantes.some(v => (me.id || "").startsWith(v));
    if (mesmoQueBot) console.log("   ATENCAO: o admin e a propria conta do bot. As mensagens vao para o chat \"Voce\" (conversa consigo mesmo).");

    console.log(`\n== GRUPOS DO BOT`);
    const grupos = Object.values(await sock.groupFetchAllParticipating());
    if (!grupos.length) console.log("   (nenhum)");
    for (const g of grupos)
        console.log(`   ${DESTINOS_GRUPO.includes(g.id) ? "[ATIVO] " : ""}"${g.subject}" -> ${g.id} | ${g.participants?.length || 0} participantes | enderecamento: ${g.addressingMode || "-"}`);
    console.log(`\n== DESTINOS atuais: ${[...DESTINOS_GRUPO, ...DESTINOS_PESSOAL].join(", ") || "(vazio: tudo vai para o admin)"}`);

    if (modo === "enviar") {
        // Mesmo caminho do bot: o numero do .env e resolvido para o ID real antes do envio.
        // (Enviar para um ID que nao existe, ex. a variante errada do nono digito, o servidor aceita
        // mas nunca entrega: aparece uma conversa "fantasma" no celular do bot.)
        console.log(`\n== TESTE DE ENVIO ao admin (pelo mesmo caminho do bot)`);
        const status = new Map();
        sock.ev.on("messages.update", ups => { for (const u of ups) if (u.update?.status != null) status.set(u.key.id, u.update.status); });
        const enviados = [];
        for (const v of variantes) console.log(`   ${v.padEnd(14)} -> resolvido para ${await resolverJid(`${v}@s.whatsapp.net`)}`);
        const destino = await resolverJid(ADMIN);
        try {
            const m = await sock.sendMessage(destino, { text: "Teste do moodle-whatsbot: se voce recebeu, o numero do admin esta certo." });
            enviados.push({ v: destino, id: m.key.id });
            console.log(`   enviado para ${destino} (id ${m.key.id})`);
        } catch (e) { console.log(`   FALHOU ao enviar para ${destino}: ${e.message}`); }
        await esperar(15000);
        const nomes = { 1: "pendente", 2: "chegou ao servidor", 3: "ENTREGUE no aparelho", 4: "LIDA", 5: "reproduzida" };
        for (const { v, id } of enviados) console.log(`   ${v}: status apos 15s -> ${nomes[status.get(id)] || "sem confirmacao"}`);
    }

    await esperar(1000);
    sock.end(undefined);
    process.exit(0);
})().catch(e => { console.error("FALHA:", e.message); process.exit(1); });
