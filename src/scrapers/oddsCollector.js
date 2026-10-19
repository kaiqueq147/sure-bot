const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const axios = require("axios");

class OddsCollector {
  constructor() {
    this.browser = null;
    this.userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    ];
  }

  async initBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
      });
    }
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  // Função principal para coletar de múltiplos sites
  async collectFromMultipleSites(websites) {
    const allOdds = {};

    for (const site of websites) {
      try {
        console.log(`🔍 Coletando de ${site}...`);
        const siteOdds = await this.collectFromSite(site);
        allOdds[site] = siteOdds;

        // Delay entre sites para evitar bloqueios
        await this.delay(2000);
      } catch (error) {
        console.error(`❌ Erro ao coletar de ${site}:`, error.message);
        allOdds[site] = [];
      }
    }

    return allOdds;
  }

  // Coletor específico para cada site
  async collectFromSite(website) {
    const browser = await this.initBrowser();
    const page = await browser.newPage();

    try {
      await page.setUserAgent(this.getRandomUserAgent());
      await page.setViewport({ width: 1366, height: 768 });

      // Configurar interceptação de requests para bloquear imagens e anúncios
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (
          req.resourceType() == "stylesheet" ||
          req.resourceType() == "image"
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Determinar estratégia de coleta baseada no site
      let odds = [];

      switch (this.getSiteType(website)) {
        case "bet365":
          odds = await this.scrapeBet365(page);
          break;
        case "betfair":
          odds = await this.scrapeBetfair(page);
          break;
        case "pinnacle":
          odds = await this.scrapePinnacle(page);
          break;
        case "1xbet":
          odds = await this.scrape1xBet(page);
          break;
        case "betway":
          odds = await this.scrapeBetway(page);
          break;
        default:
          odds = await this.scrapeGeneric(page, website);
      }

      return odds;
    } catch (error) {
      console.error(`❌ Erro no scraping de ${website}:`, error);
      return [];
    } finally {
      await page.close();
    }
  }

  getSiteType(website) {
    if (website.includes("bet365")) return "bet365";
    if (website.includes("betfair")) return "betfair";
    if (website.includes("pinnacle")) return "pinnacle";
    if (website.includes("1xbet")) return "1xbet";
    if (website.includes("betway")) return "betway";
    return "generic";
  }

  // Scrapers específicos para cada site
  async scrapeBet365(page) {
    try {
      await page.goto("https://www.bet365.com/#/HO/", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await page.waitForTimeout(3000);

      // Simular dados para demonstração (substitua pela lógica real)
      return this.generateSampleOdds("bet365", 5);
    } catch (error) {
      console.error("Erro Bet365:", error);
      return this.generateSampleOdds("bet365", 3);
    }
  }

  async scrapeBetfair(page) {
    try {
      await page.goto("https://www.betfair.com/sport", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await page.waitForTimeout(3000);

      return this.generateSampleOdds("betfair", 5);
    } catch (error) {
      console.error("Erro Betfair:", error);
      return this.generateSampleOdds("betfair", 3);
    }
  }

  async scrapePinnacle(page) {
    try {
      await page.goto("https://www.pinnacle.com/en/soccer", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await page.waitForTimeout(3000);

      return this.generateSampleOdds("pinnacle", 4);
    } catch (error) {
      console.error("Erro Pinnacle:", error);
      return this.generateSampleOdds("pinnacle", 2);
    }
  }

  async scrape1xBet(page) {
    try {
      await page.goto("https://1xbet.com/en/live/football", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await page.waitForTimeout(3000);

      return this.generateSampleOdds("1xbet", 6);
    } catch (error) {
      console.error("Erro 1xBet:", error);
      return this.generateSampleOdds("1xbet", 3);
    }
  }

  async scrapeBetway(page) {
    try {
      await page.goto("https://betway.com/sport/football", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await page.waitForTimeout(3000);

      return this.generateSampleOdds("betway", 4);
    } catch (error) {
      console.error("Erro Betway:", error);
      return this.generateSampleOdds("betway", 2);
    }
  }

  async scrapeGeneric(page, website) {
    try {
      await page.goto(`https://${website}`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await page.waitForTimeout(2000);

      return this.generateSampleOdds("generic", 3);
    } catch (error) {
      console.error(`Erro site genérico ${website}:`, error);
      return [];
    }
  }

  // Gerador de dados de exemplo (substitua pela lógica real de scraping)
  generateSampleOdds(source, count = 5) {
    const teams = [
      { home: "Real Madrid", away: "Barcelona" },
      { home: "Manchester United", away: "Manchester City" },
      { home: "Liverpool", away: "Arsenal" },
      { home: "Bayern Munich", away: "Borussia Dortmund" },
      { home: "PSG", away: "Marseille" },
      { home: "Juventus", away: "Inter Milan" },
      { home: "Chelsea", away: "Tottenham" },
      { home: "Atletico Madrid", away: "Valencia" },
    ];

    const odds = [];

    for (let i = 0; i < count; i++) {
      const match = teams[Math.floor(Math.random() * teams.length)];
      const baseOdd1 = 1.5 + Math.random() * 3;
      const baseOdd2 = 1.5 + Math.random() * 3;

      odds.push({
        id: `${source}_${Date.now()}_${i}`,
        homeTeam: match.home,
        awayTeam: match.away,
        odds: {
          home: parseFloat(baseOdd1.toFixed(2)),
          away: parseFloat(baseOdd2.toFixed(2)),
        },
        sport: "football",
        league: "Premier League",
        timestamp: Date.now(),
        source: source,
      });
    }

    return odds;
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = OddsCollector;
