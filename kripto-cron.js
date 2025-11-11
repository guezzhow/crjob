// api/kripto-cron.js
// Ini akan dijalankan oleh Vercel Cron Job.

// --- Bagian 1: Konfigurasi dan Dependensi ---
// Node.js modern mendukung fetch global, tetapi jika perlu, uncomment require:
// const fetch = require('node-fetch'); 

const TELEGRAM_BOT_TOKEN = '8338119960:AAEHjSyMwz_0CO7xdXoNqyoyRN3G307M_Cw';
const TELEGRAM_CHAT_ID = '6481572601';
const ENABLE_TELEGRAM = true;

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=1h,24h';
const CRYPTOCOMPARE_URL = 'https://min-api.cryptocompare.com/data/v2/histominute';
const RSI_PERIOD = 3;
const CMF_PERIOD = 60;

// --- Bagian 2: Fungsi Utility Inti (Diambil dari HTML) ---

async function sendTelegram(message) {
    if (!ENABLE_TELEGRAM || TELEGRAM_BOT_TOKEN.includes('YOUR')) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: TELEGRAM_CHAT_ID, 
                text: message, 
                parse_mode: 'Markdown' 
            })
        });
    } catch (e) { 
        console.warn('Telegram gagal:', e); 
    }
}

async function fetchTimeout(url, ms = 7000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        clearTimeout(id);
        throw e.name === 'AbortError' ? new Error('Timeout') : e;
    }
}

async function fetchCoins() {
    const json = await fetchTimeout(COINGECKO_URL);
    return json
        .filter(c => c.symbol !== 'btc' && c.price_change_percentage_1h_in_currency != null)
        .sort((a, b) => b.price_change_percentage_1h_in_currency - a.price_change_percentage_1h_in_currency)
        .slice(0, 25)
        .map(c => ({
            id: c.id, name: c.name, symbol: c.symbol.toUpperCase(),
            price: c.current_price,
            change1h: c.price_change_percentage_1h_in_currency,
            change24h: c.price_change_percentage_24h_in_currency,
            volume: c.total_volume, mc: c.market_cap
        }));
}

async function fetchMinute(sym) {
    try {
        const res = await fetchTimeout(`${CRYPTOCOMPARE_URL}?fsym=${sym}&tsym=USDT&limit=300&aggregate=1`);
        return res.Data?.Data?.length >= 240 ? res.Data.Data : null;
    } catch { return null; }
}

function calcRSI(closes, p) {
    if (closes.length < p + 1) return null;
    const d = closes.slice(1).map((c, i) => c - closes[i]);
    let g = 0, l = 0;
    for (let i = 0; i < p; i++) { d[i] > 0 ? g += d[i] : l -= d[i]; }
    g /= p; l /= p;
    for (let i = p; i < d.length; i++) {
        const gg = d[i] > 0 ? d[i] : 0;
        const ll = d[i] < 0 ? -d[i] : 0;
        g = (g * (p-1) + gg) / p;
        l = (l * (p-1) + ll) / p;
    }
    return l === 0 ? 100 : 100 - 100 / (1 + g/l);
}

function calcCMF(h, l, c, v, p) {
    if (c.length < p) return null;
    let mfv = 0, vol = 0;
    for (let i = c.length - p; i < c.length; i++) {
        const m = h[i] !== l[i] ? ((c[i]-l[i]) - (h[i]-c[i])) / (h[i]-l[i]) : 0;
        mfv += m * v[i]; vol += v[i];
    }
    return vol > 0 ? mfv / vol : null;
}

async function getExchange(id) {
    try {
        const res = await fetchTimeout(`https://api.coingecko.com/api/v3/coins/${id}/tickers?order=volume_desc`);
        const t = res.tickers;
        if (!t?.length) return 'N/A';
        const top = t[0], total = t.reduce((s, x) => s + x.volume, 0);
        const pct = total > 0 ? top.volume / total * 100 : 0;
        return pct > 50 ? `${top.market.name} (${pct.toFixed(1)}%)` : 'Terbagi';
    } catch { return 'N/A'; }
}


// --- Bagian 3: Fungsi Eksekusi Utama (Menggabungkan fetchData dan Logika Sinyal) ---

async function executeKriptoCheck() {
    const coins = await fetchCoins();
    const enriched = [];
    const sent = new Set(); 

    for (const c of coins) {
        const min = await fetchMinute(c.symbol);
        if (!min) continue;
        const rsi = calcRSI(min.map(x=>x.close), RSI_PERIOD);
        const cmf = calcCMF(min.map(x=>x.high), min.map(x=>x.low), min.map(x=>x.close), min.map(x=>x.volumeto), CMF_PERIOD);
        
        // Filter Server-Side: Hanya proses yang memiliki RSI>45 dan CMF>0
        if (rsi === null || cmf === null || rsi <= 45 || cmf <= 0) continue; 
        
        const exchange = await getExchange(c.id);
        const coin = { ...c, rsi, cmf, exchange };
        
        // --- LOGIKA SINYAL (Diambil dari fungsi render) ---
        const vt = coin.mc * 0.10, ht = coin.mc * 0.20, lt = coin.mc * 0.05;
        let sig = 'Normal', emoji = '➖';
        
        if (coin.change24h >= 3 && coin.change24h <= 10 && coin.volume > vt) {
            sig = 'Akumulasi'; emoji = '🟢';
        } else if (coin.change24h > 10 && coin.volume > ht) {
            sig = 'Pump'; emoji = '🚀';
        } else if (coin.change24h > 5 && coin.volume < lt) {
            sig = 'Divergensi Bullish'; emoji = '🟡';
        } else if (coin.change24h < -5 && coin.volume < lt) {
            sig = 'Divergensi Bearish'; emoji = '🟠';
        }

        // --- KIRIM SINYAL KE TELEGRAM ---
        if (!sent.has(coin.symbol) && sig !== 'Normal') {
            const volPct = (coin.volume / coin.mc * 100).toFixed(1);
            const msg = `${emoji} *${sig} DITEMUKAN*\n` +
                        `${coin.name} (${coin.symbol})\n` +
                        `24H: ${coin.change24h.toFixed(2)}%\n` +
                        `Vol: $${(coin.volume/1e6).toFixed(1)}M (${volPct}% MC)\n` +
                        `RSI: ${coin.rsi.toFixed(2)}, CMF: ${coin.cmf.toFixed(4)}`;
            await sendTelegram(msg);
            sent.add(coin.symbol);
        }
    }
    
    return { signalsSent: sent.size };
}


// --- Bagian 4: Vercel Serverless Handler ---

module.exports = async (req, res) => {
    try {
        console.log("Kripto Cron Job: Pengecekan sinyal dimulai...");
        const result = await executeKriptoCheck(); 
        
        // Kirim respons sukses ke Vercel (ini harus dilakukan!)
        res.status(200).json({ 
            status: "success", 
            message: `Pengecekan selesai. ${result.signalsSent} sinyal dikirim.`,
            signalsSent: result.signalsSent
        });

    } catch (e) {
        console.error("CRON JOB FAILED:", e.message);
        // Penting: Kirim notifikasi error ke Telegram
        await sendTelegram(`🚨 *CRON ERROR* 🚨: Gagal eksekusi logika. Pesan: ${e.message}`);
        
        // Respon error ke Vercel
        res.status(500).json({ status: "error", message: e.message });
    }
};
