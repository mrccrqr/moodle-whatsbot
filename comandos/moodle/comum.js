'use strict';

// Auxiliares usados por varias verificacoes (verificacoes.js, novidades.js).

const { agora, log }     = require("./utils");
const { retry }          = require("./auth");
const { buscarCursos }   = require("./api");

// Impede que a mesma verificacao rode em paralelo
const emAndamento = new Set();
function comGuard(nome, fn) {
    return async function () {
        if (emAndamento.has(nome)) { log("aviso", `[${nome}] ja em andamento, pulando.`); return; }
        emAndamento.add(nome);
        try { await fn(); }
        finally { emAndamento.delete(nome); }
    };
}

// Cursos do semestre atual (semestres anteriores/repercurso sao ignorados). Memoizado por 6h.
let _semestre = null, _semestreTs = 0;
async function cursosDoSemestre() {
    const ts = agora().toMillis();
    if (!_semestre || ts - _semestreTs > 6 * 3600 * 1000 || ts < _semestreTs) {
        const cursos = await retry(() => buscarCursos());
        _semestre = { cursos, ids: new Set(cursos.map(c => c.id)) };
        _semestreTs = ts;
    }
    return _semestre;
}

// Prazos de um modulo (quiz, forum, licao...) a partir dos "dates" do curso
const ROTULO_PRAZO = /vencimento|fecha|prazo/i;
function prazosDoModulo(m) {
    return (m.dates || []).filter(d => d.timestamp && ROTULO_PRAZO.test(d.label)).map(d => d.timestamp);
}

const agoraS = () => Math.floor(agora().toSeconds());

module.exports = { comGuard, cursosDoSemestre, prazosDoModulo, agoraS };
