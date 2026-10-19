// Conexão Socket.IO
const socket = io();

// Estado da aplicação
let isAutoUpdateActive = true;
let currentOdds = {};
let currentSurebets = [];
let currentStats = {};

// Elementos DOM
const elements = {
  connectionIndicator: document.getElementById("connection-indicator"),
  totalMatches: document.getElementById("total-matches"),
  totalSurebets: document.getElementById("total-surebets"),
  avgProfit: document.getElementById("avg-profit"),
  sitesMonitored: document.getElementById("sites-monitored"),
  lastUpdateTime: document.getElementById("last-update-time"),
  manualUpdateBtn: document.getElementById("manual-update"),
  toggleAutoBtn: document.getElementById("toggle-auto"),
  surebetsContainer: document.getElementById("surebets-container"),
  oddsContainer: document.getElementById("odds-container"),
  toggleOddsBtn: document.getElementById("toggle-odds"),
  profitFilter: document.getElementById("profit-filter"),
  sportFilter: document.getElementById("sport-filter"),
  modal: document.getElementById("surebet-modal"),
  modalBody: document.getElementById("modal-body"),
  notifications: document.getElementById("notifications"),
};

// Inicialização
document.addEventListener("DOMContentLoaded", () => {
  initializeEventListeners();
  updateConnectionStatus(false);
});

// Event Listeners
function initializeEventListeners() {
  // Botões
  elements.manualUpdateBtn.addEventListener("click", requestManualUpdate);
  elements.toggleAutoBtn.addEventListener("click", toggleAutoUpdate);
  elements.toggleOddsBtn.addEventListener("click", toggleOddsDisplay);

  // Filtros
  elements.profitFilter.addEventListener("change", filterSurebets);
  elements.sportFilter.addEventListener("change", filterSurebets);

  // Modal
  document.querySelector(".modal-close").addEventListener("click", closeModal);
  elements.modal.addEventListener("click", (e) => {
    if (e.target === elements.modal) closeModal();
  });

  // Escape key para fechar modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

// Socket.IO Events
socket.on("connect", () => {
  console.log("✅ Conectado ao servidor");
  updateConnectionStatus(true);
  showNotification("Conectado ao servidor", "success");
});

socket.on("disconnect", () => {
  console.log("❌ Desconectado do servidor");
  updateConnectionStatus(false);
  showNotification("Conexão perdida", "error");
});

socket.on("odds_updated", (odds) => {
  console.log("📊 Odds atualizadas:", Object.keys(odds).length, "sites");
  currentOdds = odds;
  updateOddsDisplay();
  updateLastUpdateTime();
});

socket.on("surebets_updated", (surebets) => {
  console.log("🎯 Surebets atualizadas:", surebets.length);
  currentSurebets = surebets;
  updateSurebetsDisplay();
  updateStats();

  if (surebets.length > 0) {
    showNotification(`${surebets.length} surebet(s) encontrada(s)!`, "success");
  }
});

socket.on("error", (error) => {
  console.error("❌ Erro:", error);
  showNotification("Erro: " + error, "error");
});

// Funções principais
function requestManualUpdate() {
  if (elements.manualUpdateBtn.disabled) return;

  elements.manualUpdateBtn.disabled = true;
  elements.manualUpdateBtn.innerHTML =
    '<i class="fas fa-spinner fa-spin"></i> Atualizando...';

  socket.emit("request_manual_update");

  setTimeout(() => {
    elements.manualUpdateBtn.disabled = false;
    elements.manualUpdateBtn.innerHTML =
      '<i class="fas fa-sync-alt"></i> Atualizar Agora';
  }, 5000);
}

function toggleAutoUpdate() {
  isAutoUpdateActive = !isAutoUpdateActive;

  const icon = elements.toggleAutoBtn.querySelector("i");
  const text =
    elements.toggleAutoBtn.querySelector("span") || elements.toggleAutoBtn;

  if (isAutoUpdateActive) {
    icon.className = "fas fa-pause";
    text.textContent = text.textContent.replace("Pausado", "Ativo");
    elements.toggleAutoBtn.className = "btn btn-secondary";
    showNotification("Monitoramento automático ativado", "info");
  } else {
    icon.className = "fas fa-play";
    text.textContent = text.textContent.replace("Ativo", "Pausado");
    elements.toggleAutoBtn.className = "btn btn-outline";
    showNotification("Monitoramento automático pausado", "info");
  }
}

function toggleOddsDisplay() {
  const isVisible = elements.oddsContainer.style.display !== "none";

  if (isVisible) {
    elements.oddsContainer.style.display = "none";
    elements.toggleOddsBtn.innerHTML =
      '<i class="fas fa-eye"></i> Mostrar Todas';
  } else {
    elements.oddsContainer.style.display = "grid";
    elements.toggleOddsBtn.innerHTML =
      '<i class="fas fa-eye-slash"></i> Ocultar Todas';
    updateOddsDisplay();
  }
}

function updateConnectionStatus(isConnected) {
  const indicator = elements.connectionIndicator;

  if (isConnected) {
    indicator.className = "status-indicator online";
    indicator.innerHTML = '<i class="fas fa-circle"></i> Conectado';
  } else {
    indicator.className = "status-indicator offline";
    indicator.innerHTML = '<i class="fas fa-circle"></i> Desconectado';
  }
}

function updateStats() {
  const stats = calculateStats(currentSurebets, currentOdds);

  elements.totalMatches.textContent = stats.totalMatches;
  elements.totalSurebets.textContent = stats.totalSurebets;
  elements.avgProfit.textContent = stats.avgProfit + "%";
  elements.sitesMonitored.textContent = stats.sitesMonitored;
}

function calculateStats(surebets, odds) {
  const flatOdds = [];
  let sitesCount = 0;

  for (const site in odds) {
    sitesCount++;
    if (Array.isArray(odds[site])) {
      flatOdds.push(...odds[site]);
    }
  }

  const uniqueMatches = new Set();
  flatOdds.forEach((odd) => {
    const key = `${odd.homeTeam} vs ${odd.awayTeam}`;
    uniqueMatches.add(key);
  });

  const avgProfit =
    surebets.length > 0
      ? (
          surebets.reduce((sum, sb) => sum + sb.profit, 0) / surebets.length
        ).toFixed(2)
      : 0;

  return {
    totalMatches: uniqueMatches.size,
    totalSurebets: surebets.length,
    avgProfit: avgProfit,
    sitesMonitored: sitesCount,
  };
}

function updateSurebetsDisplay() {
  if (currentSurebets.length === 0) {
    elements.surebetsContainer.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-search"></i>
                <p>Nenhuma surebet encontrada no momento</p>
            </div>
        `;
    return;
  }

  const filteredSurebets = filterSurebetsByFilters(currentSurebets);

  elements.surebetsContainer.innerHTML = filteredSurebets
    .map((surebet) => createSurebetCard(surebet))
    .join("");

  // Adicionar event listeners para os cards
  elements.surebetsContainer
    .querySelectorAll(".surebet-card")
    .forEach((card) => {
      card.addEventListener("click", () => {
        const surebetId = card.dataset.surebetId;
        const surebet = currentSurebets.find((sb) => sb.id === surebetId);
        if (surebet) showSurebetDetails(surebet);
      });
    });
}

function filterSurebetsByFilters(surebets) {
  const profitFilter = elements.profitFilter.value;
  const sportFilter = elements.sportFilter.value;

  return surebets.filter((surebet) => {
    // Filtro de lucro
    let profitMatch = true;
    if (profitFilter === "high") profitMatch = surebet.profit > 5;
    else if (profitFilter === "medium")
      profitMatch = surebet.profit >= 2 && surebet.profit <= 5;
    else if (profitFilter === "low")
      profitMatch = surebet.profit >= 1 && surebet.profit < 2;

    // Filtro de esporte
    const sportMatch = sportFilter === "all" || surebet.sport === sportFilter;

    return profitMatch && sportMatch;
  });
}

function createSurebetCard(surebet) {
  const profitClass = getProfitClass(surebet.profit);

  return `
        <div class="surebet-card" data-surebet-id="${surebet.id}">
            <div class="surebet-header">
                <div class="match-info">
                    <h3>${surebet.homeTeam} vs ${surebet.awayTeam}</h3>
                    <div class="match-details">
                        <span><i class="fas fa-trophy"></i> ${
                          surebet.league
                        }</span>
                        <span><i class="fas fa-clock"></i> ${formatTime(
                          surebet.timestamp
                        )}</span>
                    </div>
                </div>
                <div class="profit-badge ${profitClass}">
                    +${surebet.profit}%
                </div>
            </div>
            
            <div class="bets-grid">
                ${surebet.bets
                  .map(
                    (bet) => `
                    <div class="bet-info">
                        <div class="bet-outcome">
                            <span class="bet-team">${bet.team}</span>
                            <span class="bet-odds">${bet.odds}</span>
                        </div>
                        <div class="bet-details">
                            <span>Site: ${bet.site}</span>
                            <span>Stake: R$ ${bet.stake}</span>
                            <span>Retorno: R$ ${bet.potentialReturn}</span>
                            <span>Outcome: ${
                              bet.outcome === "home" ? "Casa" : "Fora"
                            }</span>
                        </div>
                    </div>
                `
                  )
                  .join("")}
            </div>
            
            <div class="surebet-summary">
                <div class="summary-left">
                    <span>Investimento Total: R$ ${surebet.totalStake}</span>
                    <span>ROI: ${surebet.roi}%</span>
                </div>
                <div class="summary-right">
                    Lucro: R$ ${surebet.expectedProfit}
                </div>
            </div>
        </div>
    `;
}

function getProfitClass(profit) {
  if (profit > 5) return "profit-high";
  if (profit >= 2) return "profit-medium";
  return "profit-low";
}

function updateOddsDisplay() {
  if (elements.oddsContainer.style.display === "none") return;

  const flatOdds = [];
  for (const site in currentOdds) {
    if (Array.isArray(currentOdds[site])) {
      currentOdds[site].forEach((odd) => {
        flatOdds.push({ ...odd, site });
      });
    }
  }

  if (flatOdds.length === 0) {
    elements.oddsContainer.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-chart-bar"></i>
                <p>Nenhuma odd disponível</p>
            </div>
        `;
    return;
  }

  elements.oddsContainer.innerHTML = flatOdds
    .map((odd) => createOddsCard(odd))
    .join("");
}

function createOddsCard(odd) {
  return `
        <div class="odds-card">
            <div class="odds-header">
                <span class="odds-match">${odd.homeTeam} vs ${odd.awayTeam}</span>
                <span class="odds-site">${odd.site}</span>
            </div>
            <div class="odds-values">
                <div class="odd-value">
                    <div class="odd-label">Casa</div>
                    <div class="odd-number">${odd.odds.home}</div>
                </div>
                <div class="odd-value">
                    <div class="odd-label">Fora</div>
                    <div class="odd-number">${odd.odds.away}</div>
                </div>
            </div>
        </div>
    `;
}

function showSurebetDetails(surebet) {
  const modalContent = `
        <div class="surebet-details">
            <h4>${surebet.homeTeam} vs ${surebet.awayTeam}</h4>
            <div class="detail-grid">
                <div class="detail-item">
                    <strong>Lucro Esperado:</strong> +${surebet.profit}%
                </div>
                <div class="detail-item">
                    <strong>ROI:</strong> ${surebet.roi}%
                </div>
                <div class="detail-item">
                    <strong>Investimento Total:</strong> R$ ${
                      surebet.totalStake
                    }
                </div>
                <div class="detail-item">
                    <strong>Lucro em R$:</strong> R$ ${surebet.expectedProfit}
                </div>
                <div class="detail-item">
                    <strong>Liga:</strong> ${surebet.league}
                </div>
                <div class="detail-item">
                    <strong>Esporte:</strong> ${surebet.sport}
                </div>
            </div>
            
            <h5>Detalhes das Apostas:</h5>
            ${surebet.bets
              .map(
                (bet, index) => `
                <div class="bet-detail-card">
                    <h6>Aposta ${index + 1}: ${bet.team} (${
                  bet.outcome === "home" ? "Casa" : "Fora"
                })</h6>
                    <div class="bet-detail-info">
                        <p><strong>Site:</strong> ${bet.site}</p>
                        <p><strong>Odd:</strong> ${bet.odds}</p>
                        <p><strong>Valor a apostar:</strong> R$ ${bet.stake}</p>
                        <p><strong>Retorno potencial:</strong> R$ ${
                          bet.potentialReturn
                        }</p>
                    </div>
                </div>
            `
              )
              .join("")}
            
            <div class="instructions">
                <h6>Instruções:</h6>
                <ol>
                    <li>Faça as apostas simultaneamente nos sites indicados</li>
                    <li>Use exatamente os valores calculados</li>
                    <li>Verifique as odds antes de confirmar</li>
                    <li>O lucro é garantido independente do resultado</li>
                </ol>
            </div>
        </div>
    `;

  elements.modalBody.innerHTML = modalContent;
  elements.modal.style.display = "block";
}

function closeModal() {
  elements.modal.style.display = "none";
}

function filterSurebets() {
  updateSurebetsDisplay();
}

function updateLastUpdateTime() {
  const now = new Date();
  elements.lastUpdateTime.textContent = now.toLocaleTimeString("pt-BR");
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;

  const icon =
    type === "success"
      ? "check"
      : type === "error"
      ? "exclamation-triangle"
      : "info-circle";
  notification.innerHTML = `
        <i class="fas fa-${icon}"></i>
        ${message}
    `;

  elements.notifications.appendChild(notification);

  // Remover após 5 segundos
  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 5000);
}
