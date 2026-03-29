/**
 * FinScope Live Data Loader
 * Reads /data/live.json and populates all dynamic elements.
 * If the file is unavailable, static HTML values show instead.
 */
(function () {

  async function load() {
    let data;
    try {
      const res = await fetch('/data/live.json?v=' + Date.now());
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) {
      console.warn('FinScope: live.json unavailable, showing static values.', e.message);
      return;
    }

    // Helper: round to 2 decimal places
    const r2 = v => Math.round(parseFloat(v) * 100) / 100;

    // Fill all elements that have data-live="fieldname"
    document.querySelectorAll('[data-live]').forEach(el => {
      const key = el.dataset.live;
      const val = data[key];
      if (val === undefined || val === null) return;

      const prefix   = el.dataset.prefix   || '';
      const suffix   = el.dataset.suffix   || '';
      const decimals = el.dataset.decimals !== undefined ? parseInt(el.dataset.decimals) : 1;

      if (key === 'lastUpdated') {
        const d = new Date(val + 'T12:00:00Z');
        el.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } else if (key === 'jobless_claims_weekly' || key === 'tariff_household_annual') {
        el.textContent = prefix + Math.round(val).toLocaleString() + suffix;
      } else {
        el.textContent = prefix + parseFloat(val).toFixed(decimals) + suffix;
      }
    });

    // Update ticker values
    const tickerMap = {
      'oil_price_brent':       { selector: '[data-ticker="oil"]',       prefix: '$', suffix: '/bbl', dec: 2 },
      'cpi_annual':            { selector: '[data-ticker="cpi"]',       prefix: '',  suffix: '%',    dec: 1 },
      'recession_probability': { selector: '[data-ticker="recession"]', prefix: '',  suffix: '%',    dec: 1 },
      'fed_rate':              { selector: '[data-ticker="fed"]',       prefix: '',  suffix: '%',    dec: 2 },
      'credit_card_apr':       { selector: '[data-ticker="apr"]',       prefix: '',  suffix: '%',    dec: 1 },
      'gas_price_us':          { selector: '[data-ticker="gas"]',       prefix: '$', suffix: '/gal', dec: 2 },
      'unemployment':          { selector: '[data-ticker="jobs"]',      prefix: '',  suffix: '%',    dec: 1 },
      'treasury_yield_10y':    { selector: '[data-ticker="treasury"]',  prefix: '',  suffix: '%',    dec: 2 },
    };

    Object.entries(tickerMap).forEach(([key, cfg]) => {
      const val = data[key];
      if (val === null || val === undefined) return;
      document.querySelectorAll(cfg.selector).forEach(el => {
        el.textContent = cfg.prefix + parseFloat(val).toFixed(cfg.dec) + cfg.suffix;
      });
    });

    // Update recession gauge bar width
    const gauge = document.getElementById('recessionGauge');
    if (gauge && data.recession_probability != null) {
      gauge.style.width = Math.min(100, data.recession_probability) + '%';
    }

    // Update recession score number
    const score = document.getElementById('recessionScore');
    if (score && data.recession_probability != null) {
      score.textContent = parseFloat(data.recession_probability).toFixed(1) + '%';
    }

    // Update "last updated" timestamp anywhere it appears
    document.querySelectorAll('.data-last-updated').forEach(el => {
      if (data.lastUpdated) {
        const d = new Date(data.lastUpdated + 'T12:00:00Z');
        el.textContent = 'Data updated ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    });

    // Color-code values based on severity
    const colors = {
      recession_probability: { danger: 40, warn: 25 },
      cpi_annual:            { danger: 4,  warn: 2.5 },
      unemployment:          { danger: 5,  warn: 4.2 },
      credit_card_apr:       { danger: 20, warn: 18 },
      oil_price_brent:       { danger: 90, warn: 70 },
      gas_price_us:          { danger: 4,  warn: 3.5 },
    };

    document.querySelectorAll('[data-live-color]').forEach(el => {
      const key = el.dataset.liveColor;
      const val = parseFloat(data[key]);
      const t   = colors[key];
      if (!t || isNaN(val)) return;
      if (val >= t.danger) el.style.color = '#EF4444';
      else if (val >= t.warn) el.style.color = '#F59E0B';
      else el.style.color = '#10B981';
    });

    console.log('FinScope: Live data loaded —', data.lastUpdated,
      '| Success rate:', data.successRate);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }

})();
