# Sure-Bot — Arbitragem de eSports (Polymarket × Thunderpick × Duel)

Monitora em tempo real o mercado de **vencedor da partida** nas três casas, cruza os mesmos jogos
mesmo com nomes diferentes e mostra no dashboard cada oportunidade de lucro garantido, com
stake sugerida e links diretos. Há um motor de arbitragem por par de casas.

## Arquitetura

```
 INGESTÃO                                MAPEAMENTO            MOTOR                     UI
┌───────────────────────────────┐
│ Polymarket                    │
│  Gamma API (REST, 60s)        │──┐
│   descobre eventos eSports    │  │
│  CLOB WS /ws/market           │  │   ┌──────────────┐    ┌───────────────────┐    ┌──────────────────┐
│   book + price_change → ask   │  ├──▶│  OddsStore   │───▶│  Matcher          │───▶│ ArbitrageEngine  │
└───────────────────────────────┘  │   │ odds em mem. │    │ aliases + Leven-  │    │ 1/o1 + 1/o2 < 1  │
┌───────────────────────────────┐  │   │ TTL/staleness│    │ shtein + tokens + │    │ taxas, confirma- │
│ Thunderpick                   │  │   │ disponibili- │    │ siglas + horário  │    │ ção, fechamento  │
│  Playwright (perfil persist.) │──┘   │ dade por casa│    │ (só quando o con- │    └────────┬─────────┘
│   intercepta GET /api/matches │      └──────────────┘    │ junto de mercados │             │ eventos
│   + SignalR /ws/websockets    │  │                       │ muda)             │             ▼
└───────────────────────────────┘  │                       └───────────────────┘    ┌──────────────────┐
┌───────────────────────────────┐  │
│ Duel (Betby)                  │──┘
│  snapshot versionado 30-60s   │
│  + deltas a cada 2s           │
└───────────────────────────────┘
                                                                                    │ HTTP + WS /ws    │
                                                                                    │ (server.ts)      │
                                                                                    └────────┬─────────┘
                                                                                             ▼
                                                                                    Dashboard (public/)
                                                                                    cards, stakes, links
```

| Etapa | Arquivo |
| --- | --- |
| WebSocket com reconexão, heartbeat e watchdog | `src/core/ReconnectingWebSocket.ts` |
| Estado das odds + staleness | `src/core/OddsStore.ts` |
| Polymarket (Gamma + CLOB WS) | `src/sources/polymarket.ts` |
| Thunderpick (Playwright + parser) | `src/sources/thunderpick.ts`, `src/sources/thunderpickExtract.ts` |
| Duel e outras casas com Betby | `src/sources/betby.ts` |
| Normalização e matching de times | `src/matching/normalize.ts`, `src/matching/matcher.ts` |
| Fórmulas e motor | `src/engine/math.ts`, `src/engine/ArbitrageEngine.ts` |
| Dashboard | `public/` |

## Como as odds são obtidas

**Polymarket.** A Gamma API lista os eventos com `tag_slug=esports` e `end_date_min=agora` (sem
o filtro vêm centenas de partidas já jogadas aguardando resolução). Em cada evento é escolhido o
mercado `sportsMarketType=moneyline` (os `child_moneyline` são mapas individuais), além de
`map_handicap` e `totals` (veja *Mercados* abaixo). O WebSocket do CLOB mantém um book local por
token. A assinatura vai em lotes de 100 tokens: com centenas numa mensagem só, o servidor não envia
nenhum `book`. A odd publicada é o preço médio para comprar `POLYMARKET_MIN_FILL_USD` (padrão $10)
percorrendo os asks. Assim, uma ordem de centavos no topo do livro não vira odd, e era isso que fazia
arbitragens piscarem várias vezes por segundo. A liquidez exibida é o total dos
`POLYMARKET_DEPTH_LEVELS` primeiros níveis, e esses níveis vão para o dashboard. A taxa de taker
oficial (`fee = shares × feeRate × p × (1−p)`, com `feeRate` lido de cada mercado, hoje 0.05 em
eSports) já é descontada da odd usada no cálculo.

**Thunderpick.** Não há API pública. O Chromium headless recebe **403 do Cloudflare**, então a
fonte abre um **navegador visível** com perfil persistente, que passa pelo desafio como qualquer
usuário. Dentro dele são interceptados:

- `POST https://thunderpick.io/api/matches` → snapshot completo (`data.upcoming` / `data.live`). Os `GET /api/matches?matchesIds=…` são partidas avulsas;
- `wss://thunderpick.io/ws/websockets` (SignalR) → deltas de mercado em tempo real por `eventId` e `marketsHidden` (mercado suspenso).

O snapshot é renovado a cada `THUNDERPICK_REFRESH_MS` sem recarregar a página. A fonte guarda as
chamadas que trouxeram partidas (método, corpo e `content-type`) e as repete com `fetch` dentro da
própria aba, com os cookies dela. Recarregar derrubava o WebSocket interno a cada ciclo. A página só
é recarregada quando esse fetch falha ou a cada `THUNDERPICK_RELOAD_MS` (30 min).

Não há técnicas de evasão (stealth, spoofing de TLS/fingerprint ou rotação de headers). Se o
desafio aparecer, a fonte fica em estado `degraded` e espera até 5 minutos para ele ser resolvido
na janela. Por padrão (`THUNDERPICK_OFFSCREEN=true`) a janela é aberta fora da área visível da
tela, então não aparece nem atrapalha. Se um desafio interativo aparecer, rode uma vez com
`THUNDERPICK_OFFSCREEN=false`, resolva na janela e o perfil persistente guarda a sessão.

**Duel.** O sportsbook da Duel é o white-label da **Betby** (`sptpub.com`). Ele consome um feed JSON
público e versionado, que funciona direto do Node, sem navegador e sem Cloudflare:

- `GET .../{live|prematch}/brand/{brand}/en/0` → manifesto com a versão e os blocos do snapshot (regenerado a cada ~30s ao vivo, ~60s pré-jogo);
- `GET .../{versão do bloco}` → blocos com `sports`, `categories`, `tournaments` e `events`;
- `GET .../{versão + Date.now()}` → delta com os eventos alterados, buscado a cada 2s, como faz o próprio site. Um `null` indica mercados recolhidos por instantes (eles voltam em deltas só com `markets`). Jogos encerrados saem no snapshot seguinte.

Os links das partidas usam `https://duel.com/sports?bt-path=/{esporte}/{categoria}/{torneio}/{evento}-{id}`; o caminho direto sem `bt-path` dá 404.

Os mercados seguem os IDs do Sportradar: **186 = Winner** (outcome `4` = casa, `5` = fora; `b: 1` = bloqueado).
A Betby também abre um WebSocket (`/api/v1/ws_new`), mas ele não envia odds para visitantes não
logados. Por isso o feed de deltas é o canal mais rápido disponível, com a mesma latência do site.
Outras casas que usam Betby podem ser adicionadas instanciando `BetbySource` com outro `brandId`.

## Mercados

Além do vencedor da série, o bot compara **handicap de mapas** e **total de mapas**, só com linhas
x.5 (sem push), e o **vencedor de cada mapa**. Cada linha vira um quote próprio ligado ao vencedor do mesmo jogo. O motor pareia
os jogos pelo vencedor e depois liga os mercados de mesmo tipo e linha. Quando as casas listam os
times em ordem invertida, a linha do handicap é negada (NAVI −1.5 de um lado = FaZe +1.5 do outro);
no total, "mais" é sempre o lado A.

| Casa | Handicap | Total |
| --- | --- | --- |
| Polymarket | `map_handicap`; `line` vale para o 1º outcome, que nem sempre é o 1º time do vencedor | `totals`, outcomes Over/Under |
| Duel (Betby) | mercado `327`, `hcp=<linha da casa>`, outcomes `1714`/`1715` | mercado `328`, `total=<linha>`, outcomes `12`/`13` |
| Thunderpick | "Match Handicap" (`period` nulo), `handicap` de cada seleção home/away | "Total Maps Played Over/Under", `baseLine` |

| Casa | Vencedor do mapa |
| --- | --- |
| Polymarket | `child_moneyline` ("Game N Winner"), orientado pelos nomes dos times |
| Duel (Betby) | mercado `330`, `mapnr=<n>`, outcomes `4`/`5` |
| Thunderpick | mercado de vencedor com `period: { type: "map", number: n }`. Não vem em `/api/matches` hoje, então raramente aparece |

Nos mapas 3 em diante o card avisa que o mapa pode não ser jogado. Cada casa tem a própria regra de
anulação para esse caso, e uma "arbitragem" pode virar aposta simples se só uma das pernas for anulada.

## Lucro pela liquidez real

Nas pernas da Polymarket, o card percorre o livro com a stake calculada pela banca. A odd média
muda a stake e a stake muda a odd, então o cálculo itera até convergir. O card mostra o lucro que
a banca realmente obtém e, por busca binária, a maior banca em que a arbitragem ainda se sustenta
("vale até $X"). O percentual do topo do card continua sendo o da odd de referência ($10).

## Interface

- **Ordenação** por lucro/EV, diferença de odd, início do jogo, liquidez ou mais recentes (salva por aba).
- **Modo lista**: uma linha por oportunidade, com as duas pernas, as odds e as stakes.
- **Gráfico** no card: na arbitragem, a margem (soma das probabilidades) ao longo do tempo contra a
  linha de 100%; no EV+, a odd da seleção em cada casa. O histórico fica em memória no servidor
  (`src/core/OddsHistory.ts`, últimas 3h, 1 ponto a cada ~5s) e é servido em `/api/history?keys=`.
- **Histerese**: uma oportunidade que some e volta em até 15s mantém o "aberta há". O log só
  registra a primeira aparição, um lucro 0,5 ponto acima do máximo já registrado ou uma
  repetição depois de 60s. O alerta sonoro/notificação de cada oportunidade só se repete após 10 min.

## Saúde das casas

O botão **Saúde** no topo abre uma tabela por casa: estado, mercados, atualizações por minuto,
idade do último dado, latência, uptime e quedas desde a primeira conexão (`src/core/Health.ts`,
também em `/api/health`). O botão fica âmbar ou vermelho quando alguma casa degrada. Latência:

- **Polymarket:** chegada das mensagens `price_change` menos o `timestamp` do servidor (inclui diferença de relógio);
- **Duel:** ida e volta da requisição de delta;
- **Thunderpick:** ida e volta do fetch do snapshot dentro da página.

## Persistência e relatório

O banco (`DB_PATH`, padrão `data/sure-bot.db`) **só grava o que você marcar**. Detectadas
automaticamente, apostas EV+ e o gráfico de odds não entram no SQL. No card, **Fiz esta** confirma
que você executou aquela arbitragem (banca, stakes e odds daquele instante). A aba **Histórico**
lista só essas. Em Node anterior ao 22.13 o bot avisa e segue sem gravar.

## Aba EV+ (apostas de valor)

`src/engine/ValueScanner.ts` junta os pares dos três motores em um grupo por jogo, com os times
orientados para o mesmo lado. Para cada time:

- **odd justa** = média da probabilidade sem margem (`(1/oA) / (1/oA + 1/oB)`) das *outras* casas;
- **EV** = odd efetiva da melhor casa × probabilidade justa − 1;
- **diferença** = maior odd / menor odd − 1;
- **abertura** = primeira odd que o bot viu naquele mercado, com a variação desde então.

Casas cuja margem no mercado passa de `EV_MAX_OVERROUND_PCT` (padrão 12%) não entram na odd justa:
em livros finos da Polymarket o spread chega a 30–80% e a probabilidade derivada não significa nada.
Não é arbitragem: o lucro só é positivo na média, e azarões geram EVs grandes com pequenas diferenças
de probabilidade (o card avisa acima de `EV_WARN_PCT`, com consenso de uma única casa e com pouca liquidez).

## Tratamento de falhas e staleness

- **Reconexão:** backoff exponencial com jitter no WebSocket da Polymarket e no navegador da Thunderpick. Há um watchdog de inatividade (sem `PONG` ou sem dados, a conexão é derrubada e refeita).
- **Casa indisponível:** quando o WS da Polymarket cai, o book local é descartado e a casa inteira é marcada indisponível até chegar um snapshot novo; nenhuma oportunidade usa odds dela nesse intervalo. O mesmo vale para o navegador da Thunderpick e para a Duel (após 3 falhas seguidas no feed, que é recarregado do zero quando volta).
- **TTL:** odds da Thunderpick sem atualização há mais de `THUNDERPICK_STALE_MS` são ignoradas.
- **Variação rápida:** a oportunidade nasce como `Validando…` e só vira `Confirmada` depois de persistir por `CONFIRM_MS`. Quando a odd muda, o card pisca e a seta indica a direção. Quando a arbitragem some, o card mostra o motivo (odds mudaram, desatualizadas ou evento saiu do pareamento) e é removido após 12s.
- **Mercado suspenso** (status ≠ 1 ou `marketsHidden`): é ignorado.
- **Avisos no card:** lucro acima de `MAX_PROFIT_PCT` (provável erro de matching ou odd congelada), score de matching < 0.9 e stake maior que a liquidez do melhor nível da Polymarket.

## Uso

```bash
npm install
npx playwright install chromium   # só para a Thunderpick, no seu PC
cp .env.example .env              # opcional
npm run dev                       # http://localhost:3000
npm run sim                       # odds sintéticas, sem acessar as casas
npm test
npm run build && npm start        # o que o container roda: node dist/index.js
```

Node 22.13 ou mais novo (o `node:sqlite` usado na persistência). Diagnóstico: `GET /health`, `/api/opportunities`, `/api/ev`, `/api/pairs` (pareamentos com scores e odds), `/api/quotes`, `/api/history?keys=k1,k2`, `/api/health` e `/api/report?hours=24`.

## Deploy (Railway)

O repositório já tem `Dockerfile` e `railway.toml`. Conecte o repo no Railway; ele constrói a imagem e sobe `node dist/index.js`. Não envie o `.env`: copie as variáveis no painel do serviço. Deixe `THUNDERPICK_ENABLED=false` — a imagem não instala o Chromium, e o Cloudflare bloqueia navegador headless. Polymarket e Duel seguem por API.

`GET /health` responde assim que o processo escuta `0.0.0.0:$PORT`. O disco do Railway é efêmero: para guardar as arbitragens marcadas, monte um volume. Se `DB_PATH` estiver vazio ou for `data/sure-bot.db`, o arquivo vai para esse volume.

## Limitações conhecidas

- Os books de eSports na Polymarket costumam ser finos, sobretudo em handicaps e totais. O card calcula o lucro pelo livro e avisa quando a banca passa do que ele sustenta.
- O formato de handicap/total da Thunderpick foi levantado dos payloads de `/api/matches`. Se a casa renomear os mercados, eles deixam de ser lidos (o vencedor continua).
- Partidas ao vivo mudam de odd em segundos e as duas casas têm atraso de aceitação de aposta. Nesse caso uma "oportunidade" pode não ser executável nas duas pernas.
- O formato interno da Thunderpick pode mudar sem aviso. O parser tem um fallback heurístico, e `THUNDERPICK_CAPTURE_DIR` grava os payloads para recalibrar.
- O mapeamento `gameId → modalidade` e o segmento de URL por modalidade foram levantados do site e cobrem as principais (CS2, Dota 2, LoL, Valorant, R6, Overwatch, MLBB, SC2). Para as outras, o link cai na página monitorada.
- Deltas da Duel perdidos (rede lenta) só são corrigidos no próximo snapshot, em até 30s ao vivo ou 60s pré-jogo.
- Verifique os termos de uso de cada casa e a legislação do seu país antes de operar.

## Créditos dos ícones (`public/icons/`)

Baixados via [Iconify](https://iconify.design):
- [Simple Icons](https://simpleicons.org) (CC0): CS2, Dota 2, LoL, Valorant, Ubisoft (R6), Battle.net (Overwatch).
- [Arcticons](https://github.com/Arcticons-Team/Arcticons) (CC BY-SA 4.0): Mobile Legends, Arena of Valor, Call of Duty. O traço foi engrossado.
- [Remix Icon](https://remixicon.com) (Apache 2.0): Honor of Kings.
- [Game Icons](https://game-icons.net) (CC BY 3.0): StarCraft II.
- [Custom Brand Icons](https://github.com/elax46/custom-brand-icons) (CC BY-NC-SA 4.0, **uso não comercial**): Rocket League.
- [Material Symbols](https://fonts.google.com/icons) (Apache 2.0): eSports genérico.

Os logos são marcas de seus respectivos donos.
