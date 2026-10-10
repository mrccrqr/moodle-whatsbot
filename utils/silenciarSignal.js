'use strict';

// A biblioteca de criptografia do WhatsApp (libsignal, usada pelo Baileys) imprime direto no console
// mensagens internas de rotina ("Closing session: SessionEntry {...}"), incluindo chaves de criptografia.
// Nao sao erros do bot: sao descartadas aqui. Qualquer outra mensagem passa normalmente.

const PREFIXOS = [
    "Closing session", "Opening session", "Removing old closed session", "Migrating session",
    "Session already", "Closing open session", "Decrypted message with closed session",
    "Failed to decrypt message", "Session error:", "Unhandled bucket type",
];

for (const metodo of ["log", "info", "warn", "error"]) {
    const original = console[metodo].bind(console);
    console[metodo] = (...args) => {
        if (typeof args[0] === "string" && PREFIXOS.some(p => args[0].startsWith(p))) return;
        original(...args);
    };
}
