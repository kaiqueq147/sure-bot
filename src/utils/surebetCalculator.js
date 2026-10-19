class SurebetCalculator {
  constructor() {
    this.minProfitMargin = 1; // Margem mínima de lucro (1%)
    this.maxStakeRatio = 0.95; // Máximo 95% da banca por surebet
  }

  // Função principal para encontrar surebets
  findSurebets(allOdds) {
    const surebets = [];
    const flatOdds = this.flattenOddsData(allOdds);

    // Agrupar por jogo (mesmo evento)
    const gameGroups = this.groupByGame(flatOdds);

    for (const gameId in gameGroups) {
      const gameOdds = gameGroups[gameId];
      const surebet = this.calculateSurebet(gameOdds);

      if (surebet && surebet.profit > this.minProfitMargin) {
        surebets.push(surebet);
      }
    }

    // Ordenar por maior lucro
    return surebets.sort((a, b) => b.profit - a.profit);
  }

  // Achatar dados de odds de todos os sites
  flattenOddsData(allOdds) {
    const flatOdds = [];

    for (const site in allOdds) {
      const siteOdds = allOdds[site];
      if (Array.isArray(siteOdds)) {
        siteOdds.forEach((odd) => {
          flatOdds.push({
            ...odd,
            site: site,
          });
        });
      }
    }

    return flatOdds;
  }

  // Agrupar odds por jogo (mesmo time casa vs visitante)
  groupByGame(flatOdds) {
    const groups = {};

    flatOdds.forEach((odd) => {
      const gameKey = this.generateGameKey(odd.homeTeam, odd.awayTeam);

      if (!groups[gameKey]) {
        groups[gameKey] = [];
      }

      groups[gameKey].push(odd);
    });

    return groups;
  }

  // Gerar chave única para o jogo
  generateGameKey(homeTeam, awayTeam) {
    const teams = [
      homeTeam.toLowerCase().trim(),
      awayTeam.toLowerCase().trim(),
    ];
    return teams.sort().join(" vs ");
  }

  // Calcular surebet para um grupo de odds do mesmo jogo
  calculateSurebet(gameOdds) {
    if (gameOdds.length < 2) return null;

    // Encontrar as melhores odds para cada resultado
    const bestOdds = this.findBestOdds(gameOdds);

    if (!bestOdds.home || !bestOdds.away) return null;

    // Calcular arbitragem
    const homeImpliedProb = 1 / bestOdds.home.odds.home;
    const awayImpliedProb = 1 / bestOdds.away.odds.away;
    const totalImpliedProb = homeImpliedProb + awayImpliedProb;

    // Se a soma das probabilidades implícitas < 1, temos uma surebet
    if (totalImpliedProb < 1) {
      const profit = (1 / totalImpliedProb - 1) * 100;

      // Calcular stakes para R$ 1000 de investimento total
      const totalStake = 1000;
      const homeStake = (homeImpliedProb / totalImpliedProb) * totalStake;
      const awayStake = (awayImpliedProb / totalImpliedProb) * totalStake;

      // Calcular retornos
      const homeReturn = homeStake * bestOdds.home.odds.home;
      const awayReturn = awayStake * bestOdds.away.odds.away;
      const expectedProfit = Math.min(homeReturn, awayReturn) - totalStake;

      return {
        id: `surebet_${Date.now()}_${Math.random()}`,
        homeTeam: bestOdds.home.homeTeam,
        awayTeam: bestOdds.home.awayTeam,
        profit: parseFloat(profit.toFixed(2)),
        totalImpliedProb: parseFloat(totalImpliedProb.toFixed(4)),
        bets: [
          {
            outcome: "home",
            team: bestOdds.home.homeTeam,
            odds: bestOdds.home.odds.home,
            site: bestOdds.home.site,
            stake: parseFloat(homeStake.toFixed(2)),
            potentialReturn: parseFloat(homeReturn.toFixed(2)),
          },
          {
            outcome: "away",
            team: bestOdds.away.awayTeam,
            odds: bestOdds.away.odds.away,
            site: bestOdds.away.site,
            stake: parseFloat(awayStake.toFixed(2)),
            potentialReturn: parseFloat(awayReturn.toFixed(2)),
          },
        ],
        totalStake: totalStake,
        expectedProfit: parseFloat(expectedProfit.toFixed(2)),
        roi: parseFloat(((expectedProfit / totalStake) * 100).toFixed(2)),
        timestamp: Date.now(),
        league: bestOdds.home.league || "N/A",
        sport: bestOdds.home.sport || "football",
      };
    }

    return null;
  }

  // Encontrar as melhores odds para cada resultado
  findBestOdds(gameOdds) {
    let bestHome = null;
    let bestAway = null;

    gameOdds.forEach((odd) => {
      // Melhor odd para vitória do time da casa
      if (!bestHome || odd.odds.home > bestHome.odds.home) {
        bestHome = odd;
      }

      // Melhor odd para vitória do time visitante
      if (!bestAway || odd.odds.away > bestAway.odds.away) {
        bestAway = odd;
      }
    });

    return { home: bestHome, away: bestAway };
  }

  // Calcular stakes otimizados para um bankroll específico
  calculateOptimalStakes(surebet, bankroll) {
    const totalImpliedProb = surebet.totalImpliedProb;
    const homeStake = (surebet.bets[0].stake / 1000) * bankroll;
    const awayStake = (surebet.bets[1].stake / 1000) * bankroll;

    return {
      homeStake: parseFloat(homeStake.toFixed(2)),
      awayStake: parseFloat(awayStake.toFixed(2)),
      totalStake: parseFloat((homeStake + awayStake).toFixed(2)),
      expectedProfit: parseFloat(
        ((surebet.expectedProfit / 1000) * bankroll).toFixed(2)
      ),
    };
  }

  // Validar se uma surebet ainda é válida (odds não mudaram)
  validateSurebet(surebet, currentOdds) {
    const flatOdds = this.flattenOddsData(currentOdds);
    const gameKey = this.generateGameKey(surebet.homeTeam, surebet.awayTeam);
    const gameOdds = this.groupByGame(flatOdds)[gameKey];

    if (!gameOdds) return false;

    const currentBestOdds = this.findBestOdds(gameOdds);

    // Verificar se as odds ainda são favoráveis (com margem de tolerância)
    const tolerance = 0.05; // 5% de tolerância

    const homeOddValid =
      currentBestOdds.home &&
      Math.abs(currentBestOdds.home.odds.home - surebet.bets[0].odds) <=
        tolerance;

    const awayOddValid =
      currentBestOdds.away &&
      Math.abs(currentBestOdds.away.odds.away - surebet.bets[1].odds) <=
        tolerance;

    return homeOddValid && awayOddValid;
  }

  // Análise de risco da surebet
  analyzeSurebetRisk(surebet) {
    const risks = [];

    // Risco de odds baixas (menos líquidas)
    if (surebet.bets[0].odds < 1.5 || surebet.bets[1].odds < 1.5) {
      risks.push("Odds baixas podem ter menor liquidez");
    }

    // Risco de margem de lucro muito baixa
    if (surebet.profit < 2) {
      risks.push("Margem de lucro baixa, risco de mudança rápida");
    }

    // Risco de sites diferentes
    if (surebet.bets[0].site === surebet.bets[1].site) {
      risks.push("Mesmo site para ambas as apostas");
    }

    // Risco de stakes muito desproporcionais
    const stakeRatio =
      Math.max(surebet.bets[0].stake, surebet.bets[1].stake) /
      Math.min(surebet.bets[0].stake, surebet.bets[1].stake);

    if (stakeRatio > 10) {
      risks.push("Stakes muito desproporcionais");
    }

    return {
      riskLevel: this.calculateRiskLevel(risks.length, surebet.profit),
      risks: risks,
      recommendation: this.getRecommendation(risks.length, surebet.profit),
    };
  }

  calculateRiskLevel(riskCount, profit) {
    if (riskCount === 0 && profit > 3) return "BAIXO";
    if (riskCount <= 1 && profit > 2) return "MÉDIO";
    if (riskCount <= 2 && profit > 1) return "ALTO";
    return "MUITO_ALTO";
  }

  getRecommendation(riskCount, profit) {
    if (riskCount === 0 && profit > 3) return "RECOMENDADO";
    if (riskCount <= 1 && profit > 2) return "ACEITAR COM CAUTELA";
    if (riskCount <= 2 && profit > 1) return "AVALIAR RISCOS";
    return "NÃO RECOMENDADO";
  }

  // Estatísticas gerais dos dados coletados
  generateStatistics(allOdds, surebets) {
    const flatOdds = this.flattenOddsData(allOdds);

    return {
      totalMatches: Object.keys(this.groupByGame(flatOdds)).length,
      totalOdds: flatOdds.length,
      totalSurebets: surebets.length,
      avgProfit:
        surebets.length > 0
          ? parseFloat(
              (
                surebets.reduce((sum, sb) => sum + sb.profit, 0) /
                surebets.length
              ).toFixed(2)
            )
          : 0,
      maxProfit:
        surebets.length > 0 ? Math.max(...surebets.map((sb) => sb.profit)) : 0,
      sitesMonitored: Object.keys(allOdds).length,
      lastUpdate: Date.now(),
    };
  }
}

module.exports = SurebetCalculator;
