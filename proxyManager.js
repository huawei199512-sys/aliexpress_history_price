// 代理池管理模块 - 支持HTTP/HTTPS/SOCKS4/SOCKS5多协议（与1688方案一致）
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
let SocksProxyAgent = null;
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch { /* 可选依赖 */ }

class ProxyManager {
  constructor() {
    this.knownGoodProxies = [];
    this.proxies = [...this.knownGoodProxies];
    this.badProxies = new Map();
    this.enabled = true;
    this.maxUsesPerProxy = 5;
    this.usedCount = new Map();
    this.lastRefreshTime = 0;
    this.refreshInterval = 300;
    this.autoRefreshIntervalMs = 30 * 60 * 1000;
    this.badProxyTTL = 60;
    this.proxyIndex = 0;
    this.autoRefreshTimer = null;
    this.refreshing = false;
  }

  getProxyProtocol(proxy) {
    if (proxy.startsWith('socks5://')) return 'socks5';
    if (proxy.startsWith('socks4://')) return 'socks4';
    if (proxy.startsWith('https://')) return 'https';
    return 'http';
  }

  normalizeProxy(proxy) {
    if (proxy.startsWith('socks') || proxy.startsWith('http')) return proxy;
    return `http://${proxy}`;
  }

  setEnabled(enabled) { this.enabled = enabled; }
  isEnabled() { return this.enabled; }

  getStatus() {
    const httpCount = this.proxies.filter(p => !p.startsWith('socks')).length;
    const socksCount = this.proxies.filter(p => p.startsWith('socks')).length;
    return {
      proxy_enabled: this.enabled,
      proxy_count: this.proxies.length,
      http_count: httpCount,
      socks_count: socksCount,
      known_good_count: this.knownGoodProxies.length,
      bad_proxy_count: this.badProxies.size,
      max_uses_per_proxy: this.maxUsesPerProxy,
      mode: '代理优先 + 直连回退（代理全部失败时自动尝试直连）',
      auto_refresh: this.getAutoRefreshStatus(),
      proxy_sources: 13,
      refresh_interval_display: `${this.autoRefreshIntervalMs / (60 * 1000)}分钟`,
    };
  }

  getAutoRefreshStatus() {
    return {
      enabled: !!this.autoRefreshTimer,
      interval_minutes: this.autoRefreshIntervalMs / (60 * 1000),
      last_refresh_time: this.lastRefreshTime ? new Date(this.lastRefreshTime).toISOString() : null,
      next_refresh_in_seconds: this.lastRefreshTime ? Math.max(0, Math.floor((this.lastRefreshTime + this.autoRefreshIntervalMs - Date.now()) / 1000)) : null,
    };
  }

  createAgent(proxy) {
    const protocol = this.getProxyProtocol(proxy);
    const proxyUrl = this.normalizeProxy(proxy);
    if (protocol === 'socks5' || protocol === 'socks4') {
      if (SocksProxyAgent) {
        const agent = new SocksProxyAgent(proxyUrl);
        // SOCKS代理也忽略自签名证书
        agent.options = { ...agent.options, rejectUnauthorized: false };
        return agent;
      }
      return null;
    }
    // 使用自定义HttpsProxyAgent，忽略证书错误（免费代理常见自签名证书）
    return new HttpsProxyAgent(proxyUrl);
  }

  // ============ 代理源获取（13源并发，与1688方案一致）============

  async fetchFromProxyScrape() {
    try {
      const url = 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=all&anonymity=all';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\r\n').filter(p => p && p.includes(':')).map(p => p.trim());
    } catch { return []; }
  }

  async fetchFromGeonode() {
    try {
      const url = 'https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http';
      const response = await axios.get(url, { timeout: 5000 });
      if (response.data && response.data.data) {
        return response.data.data.map(p => `${p.ip}:${p.port}`).filter(p => p && p !== ':');
      }
      return [];
    } catch { return []; }
  }

  async fetchFromGeonodePage2() {
    try {
      const url = 'https://proxylist.geonode.com/api/proxy-list?limit=100&page=2&sort_by=lastChecked&sort_type=desc&protocols=http';
      const response = await axios.get(url, { timeout: 5000 });
      if (response.data && response.data.data) {
        return response.data.data.map(p => `${p.ip}:${p.port}`).filter(p => p && p !== ':');
      }
      return [];
    } catch { return []; }
  }

  async fetchFromTheSpeedX() {
    try {
      const url = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n').filter(p => p && p.includes(':')).map(p => p.trim());
    } catch { return []; }
  }

  async fetchFromFreeProxyList() {
    try {
      const url = 'https://raw.githubusercontent.com/fate0/proxylist/master/proxy.list';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n')
        .filter(line => line && line.includes('http'))
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(p => p && p.host && p.port)
        .map(p => `${p.host}:${p.port}`);
    } catch { return []; }
  }

  async fetchFromSocksProxyScrape() {
    try {
      const url = 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=8000&country=all';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\r\n').filter(p => p && p.includes(':')).map(p => `socks5://${p.trim()}`);
    } catch { return []; }
  }

  async fetchFromTheSpeedXSocks() {
    try {
      const url = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n').filter(p => p && p.includes(':')).map(p => `socks5://${p.trim()}`);
    } catch { return []; }
  }

  async fetchFromJetkaiHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n').filter(p => p && p.includes(':')).map(p => p.trim());
    } catch { return []; }
  }

  async fetchFromJetkaiSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n').filter(p => p && p.includes(':')).map(p => `socks5://${p.trim()}`);
    } catch { return []; }
  }

  async fetchFromHookzofSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n').filter(p => p && p.includes(':')).map(p => `socks5://${p.trim()}`);
    } catch { return []; }
  }

  async fetchFromHubpAll() {
    try {
      const url = 'https://raw.githubusercontent.com/hubp/online-proxies/main/proxies.txt';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n').filter(p => p && p.includes(':')).map(p => p.trim());
    } catch { return []; }
  }

  async fetchFromMonosansHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n').filter(p => p && p.includes(':')).map(p => p.trim());
    } catch { return []; }
  }

  async fetchFromMonosansSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt';
      const response = await axios.get(url, { timeout: 5000 });
      return response.data.split('\n').filter(p => p && p.includes(':')).map(p => `socks5://${p.trim()}`);
    } catch { return []; }
  }

  // ============ 获取所有代理源（13源并发）============
  async fetchAllSources() {
    const sources = [
      this.fetchFromProxyScrape(),
      this.fetchFromGeonode(),
      this.fetchFromGeonodePage2(),
      this.fetchFromTheSpeedX(),
      this.fetchFromFreeProxyList(),
      this.fetchFromSocksProxyScrape(),
      this.fetchFromTheSpeedXSocks(),
      this.fetchFromJetkaiHttp(),
      this.fetchFromJetkaiSocks5(),
      this.fetchFromHookzofSocks5(),
      this.fetchFromHubpAll(),
      this.fetchFromMonosansHttp(),
      this.fetchFromMonosansSocks5(),
    ];

    const results = await Promise.allSettled(sources);
    const allProxies = [];
    let successCount = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        allProxies.push(...r.value);
        successCount++;
      }
    }
    return { proxies: allProxies, successCount };
  }

  // ============ 刷新代理池 ============
  async refreshProxies(silent = false) {
    if (this.refreshing) return this.proxies;
    this.refreshing = true;
    try {
      const { proxies, successCount } = await this.fetchAllSources();
      const httpProxies = proxies.filter(p => !p.startsWith('socks'));
      const socksProxies = proxies.filter(p => p.startsWith('socks'));

      // 去重
      const unique = [...new Set(proxies)];
      const now = Date.now();
      this.lastRefreshTime = now;

      // 合并已知好代理
      const goodSet = new Set(this.knownGoodProxies);
      const finalProxies = [...this.knownGoodProxies];
      for (const p of unique) {
        if (!goodSet.has(p) && !this.badProxies.has(p)) {
          finalProxies.push(p);
        }
      }
      this.proxies = finalProxies;

      if (!silent) {
        console.log(`[ProxyManager] 刷新完成: ${this.proxies.length} 个代理 (成功源:${successCount}/13, HTTP:${httpProxies.length}, SOCKS:${socksProxies.length}, 已知好:${this.knownGoodProxies.length})`);
      }
      return this.proxies;
    } catch (e) {
      console.warn(`[ProxyManager] 刷新代理失败: ${e.message}`);
      return this.proxies;
    } finally {
      this.refreshing = false;
    }
  }

  // ============ 获取代理（轮询策略）============
  getProxy() {
    if (!this.enabled || this.proxies.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < this.proxies.length; i++) {
      this.proxyIndex = (this.proxyIndex + 1) % this.proxies.length;
      const proxy = this.proxies[this.proxyIndex];
      if (!proxy) continue;
      const badTime = this.badProxies.get(proxy);
      if (badTime && (now - badTime) < this.badProxyTTL * 1000) continue;
      const used = this.usedCount.get(proxy) || 0;
      if (used >= this.maxUsesPerProxy) continue;
      this.usedCount.set(proxy, used + 1);
      return proxy;
    }
    // 所有代理都用过或标记为坏，重置
    this.usedCount.clear();
    return this.proxies.length > 0 ? this.proxies[0] : null;
  }

  markSuccess(proxy) {
    if (!proxy) return;
    this.badProxies.delete(proxy);
    if (!this.knownGoodProxies.includes(proxy)) {
      this.knownGoodProxies.unshift(proxy);
      if (this.knownGoodProxies.length > 200) this.knownGoodProxies.pop();
    }
  }

  markFailed(proxy) {
    if (!proxy) return;
    if (this.knownGoodProxies.includes(proxy)) {
      const failedCount = this.badProxies.get(proxy) || 0;
      if (failedCount >= 3) {
        this.knownGoodProxies = this.knownGoodProxies.filter(p => p !== proxy);
        this.badProxies.set(proxy, Date.now());
      } else {
        this.badProxies.set(proxy, failedCount + 1);
      }
    } else {
      this.badProxies.set(proxy, Date.now());
    }
  }

  startAutoRefresh(intervalMinutes = 30) {
    this.autoRefreshTimer = setInterval(async () => {
      await this.refreshProxies(true);
    }, intervalMinutes * 60 * 1000);
    console.log(`[ProxyManager] 启动自动刷新定时器：每${intervalMinutes}分钟刷新一次`);
  }

  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }
}

module.exports = new ProxyManager();
