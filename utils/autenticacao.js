'use strict';

const { useMultiFileAuthState } = require("@whiskeysockets/baileys");

// Inicializa estado de autenticacao do Baileys (persiste em pasta auth/)
async function iniciarAutenticacao() {
    return useMultiFileAuthState("auth");
}

module.exports = { iniciarAutenticacao };
