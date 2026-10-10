'use strict';

// Calculo dos lembretes intermediarios de prazo (funcoes puras, sem acesso a API).
//
// Ideia: o bot ja avisa no lancamento e no dia do vencimento. Entre os dois, distribui
// de 0 a 3 lembretes conforme a duracao do prazo, sempre em "dias redondos" faceis de ler.
//
//   prazo < 4 dias    -> nenhum lembrete           (lancamento e vencimento ja bastam)
//   4 a 44 dias       -> 1 lembrete no meio        (30 dias -> "faltam 2 semanas")
//   45 a 74 dias      -> 2 lembretes (1/3 e 2/3)   (60 dias -> 6 semanas e 3 semanas)
//   75 dias ou mais   -> 3 lembretes (1/4, 2/4, 3/4)

const DIA = 86400;

// Quantidades de dias restantes "redondas" usadas nos lembretes
const MARCOS = [90, 60, 42, 30, 21, 14, 10, 7, 5, 3, 2];

function quantidadeLembretes(totalDias) {
    if (totalDias < 4)  return 0;
    if (totalDias < 45) return 1;
    if (totalDias < 75) return 2;
    return 3;
}

// Dias restantes em que um lembrete deve sair (ordem decrescente), dado o lancamento e o prazo
function calcularMarcos(inicioTs, prazoTs) {
    const totalDias = (prazoTs - inicioTs) / DIA;
    const k = quantidadeLembretes(totalDias);
    const marcos = [];
    for (let i = 1; i <= k; i++) {
        const ideal = totalDias * (1 - i / (k + 1));
        // Pelo menos 1 dia depois do lancamento e nunca no ultimo dia (esse e o "vence hoje")
        const candidatos = MARCOS.filter(m => m >= 2 && m <= totalDias - 1 && !marcos.includes(m));
        if (!candidatos.length) break;
        marcos.push(candidatos.reduce((a, b) => Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a));
    }
    return marcos.sort((a, b) => b - a);
}

// Texto amigavel para dias restantes: "amanha", "2 semanas", "1 mes", "5 dias"
function textoFalta(dias) {
    if (dias === 1) return "amanha";
    if (dias % 30 === 0) return dias === 30 ? "1 mes" : `${dias / 30} meses`;
    if (dias % 7 === 0)  return dias === 7  ? "1 semana" : `${dias / 7} semanas`;
    return `${dias} dias`;
}

// Atraso maximo para ainda mandar um lembrete perdido (bot desligado no dia do marco).
// Marcos mais antigos que isso sao so marcados como vistos: evita, na primeira execucao,
// uma enxurrada de "faltam 9 semanas" de marcos que ja passaram faz tempo.
const ATRASO_MAX_DIAS = 2;

// Decide se um item deve receber lembrete hoje.
// estado: { prazo, enviados: [marcos ja avisados] } salvo no cache; retorna { enviar, novoEstado }.
function decidirLembrete({ inicioTs, prazoTs, diasRestantes, estado }) {
    const anterior = estado && estado.prazo === prazoTs ? estado : { prazo: prazoTs, enviados: [] };
    if (diasRestantes < 1) return { enviar: false, novoEstado: anterior };
    const pendentes = calcularMarcos(inicioTs, prazoTs).filter(m => m >= diasRestantes && !anterior.enviados.includes(m));
    if (!pendentes.length) return { enviar: false, novoEstado: anterior };
    const maisRecente = Math.min(...pendentes);
    return {
        enviar:     maisRecente - diasRestantes <= ATRASO_MAX_DIAS,
        novoEstado: { prazo: prazoTs, enviados: [...anterior.enviados, ...pendentes] },
    };
}

module.exports = { MARCOS, quantidadeLembretes, calcularMarcos, textoFalta, decidirLembrete };
