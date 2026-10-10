# Moodle WhatsBot

Bot que monitora o Moodle e envia notificacoes automaticas via WhatsApp. Verifica novas atividades, prazos, atualizacoes, links de aulas e foruns, sem precisar acessar a plataforma manualmente.

Feito para estudantes que querem receber tudo direto no WhatsApp, sem depender de email ou ficar checando o Moodle.

## Funcionalidades

- **Novas atividades** — detecta e envia com descricao, prazo e anexos
- **Prazos do dia** — avisa sobre atividades que vencem hoje
- **Atualizacoes** — detecta prazos estendidos e novos arquivos
- **Links de aulas** — detecta novos links adicionados nas disciplinas
- **Foruns** — avisa sobre foruns com prazo no dia
- **Aulas ao vivo** — avisa antes das aulas com link da sala (Mconf/ConferenciaWeb)
- **Legendas EduPlay** — envia legenda em texto ao receber link do EduPlay
- **Comando /disciplinas** — lista as disciplinas do semestre atual
- **Deteccao automatica de semestre** — nao precisa configurar manualmente
- **Auto-login** — token do Moodle e gerado e renovado automaticamente
- **Telegram como fallback** — opcional, envia por la se o WhatsApp falhar

## Horarios das verificacoes

| Horario | Verificacao |
|---------|-------------|
| 06:00 | Novas atividades |
| 10:00 | Atualizacoes (prazos estendidos, novos arquivos) |
| 12:00 | Atividades que vencem hoje |
| 14:00 | Foruns com prazo hoje |
| 15:00 | Novos links adicionados |
| 18:00, 19:00, 20:00 | Aulas ao vivo do dia |

## Tecnologias

- **Node.js** (v18+)
- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — conexao com o WhatsApp via protocolo Web (sem API oficial, sem custos)
- **Luxon** — datas e horarios

Sem banco de dados, sem servidor web. O bot roda como um processo Node.js simples.

## Instalacao

```bash
git clone https://github.com/mrccrqr/moodle-whatsbot.git
cd moodle-whatsbot
npm install
```

### Configuracao

```bash
# Cria a pasta de dados e o arquivo de configuracao
mkdir -p moodle
cp .env.example moodle/.env
```

Edite `moodle/.env` com suas credenciais. Apenas 3 campos sao obrigatorios:

```env
MOODLE_USER=seu_usuario
MOODLE_PASS=sua_senha
ADMIN_JID=5577999999999@s.whatsapp.net
```

O token do Moodle e gerado automaticamente no primeiro login. O semestre e detectado automaticamente pelo nome dos cursos.

### Personalizacao (opcional)

Edite `comandos/moodle/disciplinas.json` para:
- **nomesCurtos** — abreviar nomes longos nas notificacoes
- **linksFixos** — links de salas de aula que nao mudam
- **disciplinasIgnoradas** — disciplinas que nao devem gerar notificacao de aula
- **aulasExtras** — aulas que nao aparecem no calendario do Moodle

### Executar

```bash
npm start
```

Na primeira execucao, escaneie o QR code que aparece no terminal com o WhatsApp.

## Estrutura

```
moodle-whatsbot/
  index.js                  # WhatsApp + roteamento de comandos
  comandos/
    moodle/                 # Modulo principal
      config.js             # Variaveis de ambiente
      api.js                # Chamadas a API do Moodle
      auth.js               # Login e renovacao de token
      verificacoes.js       # Verificacoes agendadas
      agendamento.js        # Agendador de tarefas
      lti.js                # Resolucao de links LTI/Mconf
      notificacoes.js       # Envio WhatsApp + Telegram
      ...                   # cache, envios, formatacao, http, utils
    disciplinas.js          # Comando /disciplinas
    eduplay.js              # Legendas do EduPlay
  utils/
    wa.js                   # Wrapper de envio WhatsApp
    autenticacao.js         # Autenticacao Baileys
  moodle/                   # Dados em runtime (gitignored)
    .env                    # Suas credenciais
    cache.json              # Cache de atividades notificadas
```

## Licenca

ISC
