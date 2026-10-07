#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>

#include <esp_private/brownout.h>

const uint8_t PIN_RED    = 5;
const uint8_t PIN_YELLOW = 6;
const uint8_t PIN_GREEN  = 7;
const uint8_t PIN_CONFIG = 4;

const bool ACTIVE_LOW = true;

const uint32_t SERIAL_BAUD = 115200;

const uint16_t NET_PORT = 8234;

const uint32_t CONFIG_TIMEOUT_MS   = 15000;
const uint32_t CONFIG_SESSION_MS   = 600000;
const uint32_t WIFI_RETRY_MS       = 5000;
const uint32_t SETUP_WIFI_WAIT_MS  = 15000;

const char *FW_VERSION = "1.9.0";

const char *AP_PREFIX = "DSH-Beacon";
const char *NVS_NS    = "dsh-led";

const uint32_t PWM_FREQ = 1000;
const uint8_t  PWM_BITS = 10;
const uint16_t PWM_MAX  = (1u << PWM_BITS) - 1;
const uint16_t PWM_MIN  = 20;

const uint16_t BREATHE_PERIOD_MS = 2400;

const uint32_t TOOLS_HOLD_MS = BREATHE_PERIOD_MS;

const uint32_t TOOLS_HOLD_MAX_MS = 10000;

const uint32_t STALE_TIMEOUT_MS = 300000UL;

const uint16_t NOTIFY_ON_MS  = 150;
const uint16_t NOTIFY_OFF_MS = 150;
const uint8_t  NOTIFY_BLINKS = 2;

enum LampEffect {
  LAMP_OFF,
  LAMP_SOLID,
  LAMP_BREATHE,
  LAMP_SLEEP,
  LAMP_SLOW_BLINK,
  LAMP_FAST_BLINK
};

struct Lamp {
  uint8_t  pin;
  LampEffect effect;
};

Lamp lampYellow = { PIN_YELLOW, LAMP_OFF };
Lamp lampGreen  = { PIN_GREEN,  LAMP_OFF };
Lamp lampRed    = { PIN_RED,    LAMP_OFF };

String   currentState = "off";
uint32_t lastCommandMs = 0;

bool     toolsActive        = false;
bool     toolsHoldPending   = false;
uint32_t toolsOffAtMs       = 0;

bool     notifyActive  = false;
uint32_t notifyStartMs = 0;
String   notifyAfter   = "";
String   savedState    = "";

uint32_t savedClearedCount = 0;

uint32_t loopCount = 0;

uint32_t lastLoopMs = 0;
uint32_t maxLoopMs = 0;
uint32_t stallCount = 0;

bool     configMode  = false;
uint32_t configStartMs = 0;

uint32_t lastConfigActivityMs = 0;
bool     netUp       = false;
bool     netAttached = false;
bool     scanRunning = false;
uint32_t scanStartedMs = 0;
uint32_t lastAttemptMs = 0;
bool     connectPending = false;

bool usbMode = false;

bool switchWifiPreferred = false;

bool switchRawAtBoot = false;

const uint32_t SWITCH_DEBOUNCE_MS = 50;
const uint32_t SWITCH_POLL_MS     = 200;

void reportResetReason();
void reportBootMode();
const char *resetReasonText();
void markIntentionalRestart(const char *why);
bool waitForSerialInput(uint32_t ms);

void announceReady(const char *why);

bool readModeSwitchWifiPreferred();

void checkModeSwitch(uint32_t nowMs);

RTC_NOINIT_ATTR struct {
  uint32_t magic;
  uint32_t boots;
  char     lastMode[6];
  uint32_t lastUptimeS;
  char     lastReason[24];
  char     resetText[56];

  char     prevResetText[56];
} bootDiag;

const uint32_t BOOT_DIAG_MAGIC = 0xD5C3E501u;

const uint8_t RX_LOG_MAX = 8;

struct RxLogEntry {
  uint32_t ms;
  char     cmd[24];
};

RxLogEntry rxLog[RX_LOG_MAX];
uint8_t    rxLogCount = 0;
uint8_t    rxLogNext  = 0;

void recordRx(const String &cmd) {
  RxLogEntry &e = rxLog[rxLogNext];
  e.ms = millis();
  strncpy(e.cmd, cmd.c_str(), sizeof(e.cmd) - 1);
  e.cmd[sizeof(e.cmd) - 1] = '\0';
  rxLogNext = (rxLogNext + 1) % RX_LOG_MAX;
  if (rxLogCount < RX_LOG_MAX) rxLogCount++;
}

void printRxLog() {
  Serial.print("RX(");
  Serial.print(rxLogCount);
  Serial.print(")");
  const uint8_t start = (rxLogCount < RX_LOG_MAX) ? 0 : rxLogNext;
  for (uint8_t i = 0; i < rxLogCount; i++) {
    const RxLogEntry &e = rxLog[(start + i) % RX_LOG_MAX];
    Serial.print(' ');
    Serial.print(e.cmd);
    Serial.print('@');
    Serial.print(e.ms);
    if (i + 1 < rxLogCount) Serial.print('|');
  }
  Serial.println();
}

const char *lastRxCmd() {
  if (rxLogCount == 0) return "-";
  return rxLog[(rxLogNext + RX_LOG_MAX - 1) % RX_LOG_MAX].cmd;
}

const char *NVS_DIAG_NS = "dsh-diag";

bool     rtcLost      = false;
uint32_t nvsBootCount = 0;
String   nvsLastReset = "";
String   nvsPrevReset = "";

void recordResetHistory();

bool     hostHeard    = false;
uint32_t lastReadyMs  = 0;
uint8_t  readyResends = 0;
const uint8_t  READY_RESEND_MAX = 6;
const uint32_t READY_RESEND_MS  = 5000;

String   wifiSsid = "";
String   wifiPass = "";
String   netBuf   = "";
WiFiClient *netClient = nullptr;

uint32_t netInboundMs = 0;

uint32_t netProbeMs   = 0;
uint32_t netProbeFail = 0;

const uint32_t NET_PROBE_IDLE_MS = 15000;

uint8_t  cfgTxPowerDbm = 20;

uint8_t  cfgConfigTxDbm = 8;
bool     cfgBodEnabled = true;

const int8_t TX_POWER_CHOICES_DBM[] = {20, 13, 8, 5, 2};
const size_t TX_POWER_CHOICE_COUNT  = sizeof(TX_POWER_CHOICES_DBM) / sizeof(TX_POWER_CHOICES_DBM[0]);

void applyPowerSettings();

WebServer webServer(80);
DNSServer dnsServer;
WiFiServer netServer(NET_PORT);
WiFiUDP   netUdp;

const char CONFIG_PAGE[] PROGMEM = R"HTML(<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 状态灯配网</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;margin:0;padding:24px;background:#f5f5f7;color:#1d1d1f}h1{font-size:19px;margin:0 0 4px}p.sub{margin:0 0 20px;color:#6e6e73;font-size:13px}.card{background:#fff;border-radius:12px;padding:18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}label{display:block;font-size:13px;margin:0 0 6px;color:#6e6e73}input,select,button{width:100%;box-sizing:border-box;font-size:15px;padding:11px;border-radius:8px;border:1px solid #d2d2d7;background:#fff;color:#1d1d1f}button{background:#0071e3;color:#fff;border:0;font-weight:600;cursor:pointer;margin-top:10px}button.sec{background:#e8e8ed;color:#1d1d1f;font-weight:500}table{width:100%;font-size:13px;border-collapse:collapse}td{padding:5px 0;color:#6e6e73}td.v{color:#1d1d1f;text-align:right;font-weight:500}</style></head><body><h1>DSH 状态灯</h1><p class="sub">选一个 WiFi 填密码保存，板子会重启并连上去</p><div class="card"><label>WiFi 名称</label><input id="ssid" list="nets" placeholder="点击下方扫描，或直接输入" autocomplete="off"><datalist id="nets"></datalist><label style="margin-top:14px">密码</label><input id="pass" type="password" placeholder="无密码留空"><button type="button" class="sec" id="scanbtn" onclick="scan()">扫描附近 WiFi</button><button type="button" onclick="save()">保存并重启</button></div><div class="card"><table><tr><td>板子名称</td><td class="v">__NAME__</td></tr><tr><td>固件</td><td class="v">__FW__</td></tr><tr><td>已存凭据</td><td class="v">__SAVED__</td></tr><tr><td>启动次数</td><td class="v">__BOOTS__</td></tr><tr><td>本次启动原因</td><td class="v">__RESET__</td></tr><tr><td>上次启动原因</td><td class="v">__PREVRESET__</td></tr><tr><td>NVS 历史（断电也在）</td><td class="v">__NVSHIST__</td></tr><tr><td>配网发射功率</td><td class="v">__TXP__ dBm</td></tr><tr><td>上次模式/存活</td><td class="v">__PREV__</td></tr></table><button type="button" class="sec" onclick="if(confirm('清除已保存的 WiFi 凭据并重启？'))location='/forget'">恢复出厂</button></div><script>function fill(a){var d=document.getElementById('nets');d.innerHTML=a.map(function(s){return '<option value="'+s.replace(/"/g,'')+'">'}).join('');if(!a.length)alert('没扫到任何 WiFi，再点一次扫描');}function scan(){var b=document.getElementById('scanbtn');b.textContent='扫描中…';var t=0;fetch('/scan',{cache:'no-store'}).then(function(){var iv=setInterval(function(){t++;fetch('/scanresult',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j.scanning){if(t>40){clearInterval(iv);b.textContent='扫描附近 WiFi';alert('扫描超时，请重试');}return;}clearInterval(iv);b.textContent='扫描附近 WiFi';fill(j);}).catch(function(){clearInterval(iv);b.textContent='扫描附近 WiFi';});},400);});}function save(){var s=document.getElementById('ssid').value.trim();if(!s){alert('请填写 WiFi 名称');return;}location='/save?ssid='+encodeURIComponent(s)+'&pass='+encodeURIComponent(document.getElementById('pass').value);}</script></body></html>)HTML";

void writeLed(uint8_t pin, uint16_t brightness) {
  if (brightness > PWM_MAX) brightness = PWM_MAX;
  uint32_t duty = ACTIVE_LOW ? (PWM_MAX - brightness) : brightness;
  ledcWrite(pin, duty);
}

uint16_t breatheValue(uint32_t nowMs, uint16_t periodMs) {
  uint32_t phase = nowMs % periodMs;
  uint32_t half  = periodMs / 2;
  if (phase < half) return (uint16_t)map(phase, 0, half, PWM_MIN, PWM_MAX);
  return (uint16_t)map(phase, half, periodMs, PWM_MAX, PWM_MIN);
}

uint16_t renderLamp(const Lamp &lamp, uint32_t nowMs) {
  switch (lamp.effect) {
    case LAMP_SOLID:      return PWM_MAX;
    case LAMP_BREATHE:    return breatheValue(nowMs, BREATHE_PERIOD_MS);
    case LAMP_SLEEP:      return breatheValue(nowMs + BREATHE_PERIOD_MS / 2, BREATHE_PERIOD_MS);
    case LAMP_SLOW_BLINK: return ((nowMs / 600) % 2 == 0) ? PWM_MAX : 0;
    case LAMP_FAST_BLINK: return ((nowMs / 140) % 2 == 0) ? PWM_MAX : 0;
    case LAMP_OFF:
    default:              return 0;
  }
}

void allLampsOff() {
  lampYellow.effect = LAMP_OFF;
  lampGreen.effect  = LAMP_OFF;
  lampRed.effect    = LAMP_OFF;
}

void applyStateEffects(const String &fullState) {
  String state = fullState;
  bool planMode = false;
  if (state.endsWith("+plan")) {
    planMode = true;
    state = state.substring(0, state.length() - 5);
    state.trim();
  }

  allLampsOff();

  if (state == "thinking") {
    lampYellow.effect = LAMP_BREATHE;
  } else if (state == "busy") {
    lampGreen.effect = LAMP_SLOW_BLINK;
  } else if (state == "error") {
    lampRed.effect = LAMP_SOLID;
  } else if (state == "alarm") {
    lampYellow.effect = LAMP_FAST_BLINK;
  } else if (state == "success") {
    lampGreen.effect = LAMP_SOLID;
  } else if (state == "plan") {
    lampGreen.effect = LAMP_SOLID;
  }

  if (planMode) {
    lampGreen.effect = LAMP_SOLID;
  }
}

void updateToolsEffect(uint32_t nowMs) {
  if (toolsActive && toolsHoldPending) {
    const uint32_t waited = nowMs - toolsOffAtMs;
    const bool expired = waited >= TOOLS_HOLD_MS;
    const bool overCap = waited >= TOOLS_HOLD_MAX_MS;
    if (expired || overCap) {
      toolsActive = false;
      toolsHoldPending = false;
      applyStateEffects(currentState);
      return;
    }
  }

  if (toolsActive && currentState.startsWith("thinking") && lampGreen.effect != LAMP_SOLID) {
    lampGreen.effect = LAMP_SLEEP;
  }
}

void onToolsOn(uint32_t nowMs) {
  toolsActive = true;
  toolsHoldPending = false;
}

void onToolsOff(uint32_t nowMs) {
  if (!toolsActive) return;
  if (toolsHoldPending) {
    return;
  }
  toolsHoldPending = true;
  toolsOffAtMs = nowMs;
}

void resetTools() {
  toolsActive = false;
  toolsHoldPending = false;
}

const char *effectName(LampEffect e) {
  switch (e) {
    case LAMP_OFF:        return "OFF";
    case LAMP_SOLID:      return "SOLID";
    case LAMP_BREATHE:    return "BREATHE";
    case LAMP_SLEEP:      return "SLEEP";
    case LAMP_SLOW_BLINK: return "SLOW_BLINK";
    case LAMP_FAST_BLINK: return "FAST_BLINK";
    default:              return "?";
  }
}

bool applyCommand(const String &raw) {
  String cmd = raw;
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return false;

  if (cmd == "state?" || cmd == "state") {
    Serial.print("STATE ");
    Serial.print(currentState);
    Serial.print(" | plan=");
    Serial.print(currentState.endsWith("+plan") ? 1 : 0);
    Serial.print(" tools=");
    Serial.print(toolsActive ? 1 : 0);
    Serial.print(" notify=");
    Serial.print(notifyActive ? 1 : 0);
    Serial.print(" saved=");
    Serial.print(savedState.length() == 0 ? "<none>" : savedState);
    Serial.print(" after=");
    Serial.print(notifyAfter.length() == 0 ? "<none>" : notifyAfter);
    Serial.print(" savedcleared=");
    Serial.print(savedClearedCount);
    Serial.print(" loops=");
    Serial.print(loopCount);
    Serial.print(" lastloop=");
    Serial.print(lastLoopMs);
    Serial.print(" maxloop=");
    Serial.print(maxLoopMs);
    Serial.print(" stalls=");
    Serial.print(stallCount);
    Serial.print(" now=");
    Serial.println(millis());

    Serial.print("LAMPS Y=");
    Serial.print(effectName(lampYellow.effect));
    Serial.print(" G=");
    Serial.print(effectName(lampGreen.effect));
    Serial.print(" R=");
    Serial.print(effectName(lampRed.effect));

    Serial.print(" pol=");
    Serial.println(ACTIVE_LOW ? "active-low" : "active-high");

    printRxLog();
    return true;
  }

  if (cmd == "power" || cmd.startsWith("power ")) {
    String arg = cmd.length() > 6 ? cmd.substring(6) : String("");
    arg.trim();

    if (arg.length() == 0) {
      Serial.print("POWER tx=");
      Serial.print(cfgTxPowerDbm);
      Serial.print("dBm bod=");
      Serial.print(cfgBodEnabled ? "on" : "off");
      Serial.print(" choices=");
      for (size_t i = 0; i < TX_POWER_CHOICE_COUNT; i++) {
        if (i) Serial.print("/");
        Serial.print(TX_POWER_CHOICES_DBM[i]);
      }
      Serial.println();
      return true;
    }

    if (arg.startsWith("tx ")) {
      const int want = arg.substring(3).toInt();
      bool ok = false;
      for (size_t i = 0; i < TX_POWER_CHOICE_COUNT; i++) {
        if (TX_POWER_CHOICES_DBM[i] == want) { ok = true; break; }
      }
      if (!ok) {
        Serial.println("ERR power tx 只认 20/13/8/5/2 (dBm)");
        return true;
      }
      cfgTxPowerDbm = (uint8_t)want;
      savePowerSettings();
      applyPowerSettings();
      Serial.print("OK power tx=");
      Serial.print(cfgTxPowerDbm);
      Serial.println("dBm（发射电流峰值随之下调）");
      return true;
    }

    if (arg.startsWith("bod ")) {
      const String v = arg.substring(4);
      if (v == "on") {
        cfgBodEnabled = true;
      } else if (v == "off") {
        cfgBodEnabled = false;
      } else {
        Serial.println("ERR power bod 只认 on/off");
        return true;
      }
      savePowerSettings();
      applyPowerSettings();
      Serial.print("OK power bod=");
      Serial.println(cfgBodEnabled ? "on" : "off");
      if (!cfgBodEnabled) {
        Serial.println("注意：掉电检测已关闭，欠压时 flash 有写坏风险，仅用于实验");
      }
      return true;
    }

    Serial.println("ERR power 只认 tx <n> / bod <on|off>");
    return true;
  }

  if (cmd == "wifi?" || cmd == "wifi") {
    Serial.print("WIFI mode=");
    Serial.print(usbMode ? "usb" : "wifi");
    Serial.print(" ssid=");
    Serial.print(wifiSsid.length() == 0 ? "<none>" : wifiSsid);
    Serial.print(" saved=");
    Serial.print(wifiSsid.length() == 0 ? 0 : 1);
    Serial.print(" state=");
    Serial.print(configMode ? "config" : (WiFi.status() == WL_CONNECTED ? "connected" : "idle"));
    Serial.print(" ip=");
    Serial.print(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString()
                                               : (configMode ? WiFi.softAPIP().toString() : String("<none>")));
    Serial.print(" rssi=");
    Serial.print(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
    Serial.print(" tcp=");
    Serial.print(netAttached ? 1 : 0);

    Serial.print(" sw=");
    Serial.print(switchWifiPreferred ? 1 : 0);
    Serial.print(" swBoot=");
    Serial.print(switchRawAtBoot ? 1 : 0);
    Serial.print(" netTalkAge=");
    Serial.print(netInboundMs == 0 ? 0 : millis() - netInboundMs);

    Serial.print(" tx=");
    Serial.print(cfgTxPowerDbm);
    Serial.print("dBm bod=");
    Serial.print(cfgBodEnabled ? "on" : "off");
    Serial.print(" scanning=");
    Serial.print(scanRunning ? 1 : 0);
    Serial.print(" scanResult=");
    Serial.print(WiFi.scanComplete());
    Serial.print(" port=");
    Serial.println(NET_PORT);
    return true;
  }

  if (cmd.startsWith("wifi ")) {
    String arg = cmd.substring(5);
    arg.trim();

    if (arg == "clear") {
      clearWifiCreds();
      Serial.println("凭据已清除，重启进入配网模式");
      delay(200);
      markIntentionalRestart("wifi clear");
      ESP.restart();
    }

    return false;
  }

  if (cmd == "mode" || cmd.startsWith("mode ")) {
    Serial.print("MODE current=");
    Serial.print(usbMode ? "usb" : "wifi");
    Serial.print(" switch=");
    Serial.print(switchWifiPreferred ? "closed(wifi)" : "open(wired)");
    Serial.print(" switchBoot=");
    Serial.println(switchRawAtBoot ? 1 : 0);
    if (cmd.length() > 5) {
      Serial.println("MODE 只读：模式由 GPIO4 拨动开关决定，请拨开关而不是敲命令");
    }
    return true;
  }

  if (cmd == "notify" || cmd.startsWith("notify ")) {
    String after = "";
    if (cmd.length() > 7) {
      after = cmd.substring(7);
      after.trim();
    }
    if (!notifyActive) savedState = currentState;
    notifyAfter  = after;
    notifyActive = true;
    notifyStartMs = millis();
    return true;
  }

  if (cmd == "tools" || cmd.startsWith("tools ")) {
    String arg = cmd.length() > 6 ? cmd.substring(6) : String("");
    arg.trim();
    if (arg == "on" || arg == "1" || arg == "true") {
      onToolsOn(millis());
      return true;
    }
    if (arg == "off" || arg == "0" || arg == "false") {
      onToolsOff(millis());
      return true;
    }
    return false;
  }

  String rest = cmd;

  bool planMode = false;
  if (rest.endsWith("+plan")) {
    planMode = true;
    rest = rest.substring(0, rest.length() - 5);
    rest.trim();
  }

  const String base = rest;

  bool known = (base == "off" || base == "idle" ||
                base == "thinking" || base == "think" ||
                base == "busy" ||
                base == "error" || base == "fail" ||
                base == "alarm" || base == "wait" ||
                base == "success" || base == "done" ||
                base == "plan");
  if (!known) return false;

  String canon = base;
  if (canon == "idle")  canon = "off";
  if (canon == "think") canon = "thinking";
  if (canon == "fail")  canon = "error";
  if (canon == "wait")  canon = "alarm";
  if (canon == "done")  canon = "success";

  const String nextState = planMode ? (canon + "+plan") : canon;

  if (notifyActive && nextState != currentState) {
    savedState = "";
    savedClearedCount++;
  }

  currentState = nextState;

  if (canon == "off" || canon == "error" || canon == "alarm" || canon == "success") {
    resetTools();
  }

  applyStateEffects(nextState);
  return true;
}

void selfTest() {
  Serial.println("ESP32_STATUS_LIGHT SELFTEST");
  writeLed(PIN_RED, PWM_MAX);    delay(400); writeLed(PIN_RED, 0);
  writeLed(PIN_YELLOW, PWM_MAX); delay(400); writeLed(PIN_YELLOW, 0);
  writeLed(PIN_GREEN, PWM_MAX);  delay(400); writeLed(PIN_GREEN, 0);
  delay(200);
}

void renderConfigLamp(uint32_t nowMs) {
  const uint16_t v = ((nowMs / 500) % 2 == 0) ? PWM_MAX : 0;
  writeLed(PIN_GREEN, 0);
  writeLed(PIN_YELLOW, 0);
  writeLed(PIN_RED, v);
}

String chipSuffix() {
  uint64_t mac = ESP.getEfuseMac();
  char buf[5];
  snprintf(buf, sizeof(buf), "%04X", (uint16_t)(mac & 0xFFFF));
  return String(buf);
}

String apName() {
  return String(AP_PREFIX) + "-" + chipSuffix();
}

bool loadWifiCreds() {
  Preferences prefs;
  prefs.begin(NVS_NS, true);
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  prefs.end();
  return wifiSsid.length() > 0;
}

void saveWifiCreds(const String &ssid, const String &pass) {
  Preferences prefs;
  prefs.begin(NVS_NS, false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
}

void clearWifiCreds() {
  Preferences prefs;
  prefs.begin(NVS_NS, false);
  prefs.clear();
  prefs.end();
  wifiSsid = "";
  wifiPass = "";
}

void applyPowerSettings() {
  if (WiFi.getMode() != WIFI_OFF) {

    const uint8_t dbm = configMode ? cfgConfigTxDbm : cfgTxPowerDbm;
    WiFi.setTxPower((wifi_power_t)(dbm * 4));
  }
  if (cfgBodEnabled) {
    esp_brownout_init();
  } else {
    esp_brownout_disable();
  }
}

void loadPowerSettings() {
  Preferences prefs;
  prefs.begin(NVS_NS, true);
  cfgTxPowerDbm = prefs.getUChar("txp", 20);
  cfgBodEnabled = prefs.getUChar("bod", 1) != 0;
  prefs.end();
}

void savePowerSettings() {
  Preferences prefs;
  prefs.begin(NVS_NS, false);
  prefs.putUChar("txp", cfgTxPowerDbm);
  prefs.putUChar("bod", cfgBodEnabled ? 1 : 0);
  prefs.end();
}

void stopServers() {
  netServer.end();
  netUdp.stop();
  webServer.stop();
}

void connectWifi() {
  if (wifiSsid.length() == 0) return;
  WiFi.mode(WIFI_STA);

  WiFi.setSleep(true);

  applyPowerSettings();
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  connectPending = true;
  lastAttemptMs = millis();
  Serial.print("连接 WiFi：");
  Serial.println(wifiSsid);
}

void enterConfigMode() {

  if (usbMode) {
    Serial.println("USB 模式下不进入配网模式");
    return;
  }
  if (configMode) return;
  stopServers();
  configMode = true;
  configStartMs = millis();

  lastConfigActivityMs = configStartMs;
  netUp = false;
  netAttached = false;
  scanRunning = false;
  connectPending = false;

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName().c_str());
  delay(200);

  applyPowerSettings();
  dnsServer.start(53, "*", WiFi.softAPIP());

  webServer.on("/", []() {
    lastConfigActivityMs = millis();
    String page = FPSTR(CONFIG_PAGE);
    page.replace("__NAME__", apName());
    page.replace("__FW__", FW_VERSION);
    page.replace("__SAVED__", wifiSsid.length() > 0 ? ("已保存: " + wifiSsid) : "无");

    page.replace("__BOOTS__", String(bootDiag.boots));
    page.replace("__RESET__", bootDiag.resetText[0] ? String(bootDiag.resetText) : String(resetReasonText()));

    page.replace("__PREVRESET__", bootDiag.prevResetText[0] ? String(bootDiag.prevResetText) : String("(未记录)"));

    page.replace("__NVSHIST__",
                 String(nvsBootCount) + " 次" +
                     (rtcLost ? " · 本次完全断电" : "") +
                     " · 上次 " + (nvsLastReset.length() ? nvsLastReset : String("(无)")));
    page.replace("__TXP__", String(cfgConfigTxDbm));
    page.replace("__PREV__", bootDiag.lastReason[0]
                                 ? (String(bootDiag.lastMode) + " " + String(bootDiag.lastUptimeS) + "s " + String(bootDiag.lastReason))
                                 : String("(首次上电)"));
    webServer.send(200, "text/html; charset=utf-8", page);
  });

  webServer.on("/scan", []() {

    lastConfigActivityMs = millis();

    if (!scanRunning) {
      scanRunning = true;
      scanStartedMs = millis();
      WiFi.scanNetworks(true, true);
    }
    webServer.send(202, "application/json", "{\"scanning\":true}");
  });

  webServer.on("/save", []() {
    lastConfigActivityMs = millis();
    const String ssid = webServer.arg("ssid");
    const String pass = webServer.arg("pass");
    if (ssid.length() == 0) {
      webServer.send(400, "text/plain; charset=utf-8", "缺少 WiFi 名称");
      return;
    }
    saveWifiCreds(ssid, pass);
    webServer.send(200, "text/html; charset=utf-8",
                   "<!doctype html><meta charset='utf-8'><body style='font-family:sans-serif;padding:24px'>"
                   "<h3>已保存，正在重启…</h3><p>板子会连上 " + ssid + "，红灯停止闪烁即成功。</p></body>");
    delay(600);
    markIntentionalRestart("web /save");
    ESP.restart();
  });

  webServer.on("/forget", []() {
    lastConfigActivityMs = millis();
    clearWifiCreds();
    webServer.send(200, "text/html; charset=utf-8",
                   "<!doctype html><meta charset='utf-8'><body style='font-family:sans-serif;padding:24px'>"
                   "<h3>凭据已清除，正在重启…</h3></body>");
    delay(600);
    markIntentionalRestart("web /forget");
    ESP.restart();
  });

  webServer.on("/scanresult", []() {
    if (scanRunning) {
      webServer.send(202, "application/json", "{\"scanning\":true}");
      return;
    }
    const int n = WiFi.scanComplete();
    if (n < 0) {
      webServer.send(200, "application/json", "[]");
      return;
    }
    String json = "[";
    for (int i = 0; i < n; i++) {
      if (i > 0) json += ",";
      String s = WiFi.SSID(i);
      s.replace("\\", "");
      s.replace("\"", "");
      if (s.length() == 0) continue;
      if (json.length() > 1) json += ",";
      json += "\"" + s + "\"";
    }
    json += "]";
    WiFi.scanDelete();
    webServer.send(200, "application/json", json);
  });

  webServer.onNotFound([]() {
    webServer.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
    webServer.send(302, "text/plain", "");
  });

  webServer.begin();

  Serial.print("进入配网模式。热点：");
  Serial.print(apName());
  Serial.print("  配置页：http://");
  Serial.println(WiFi.softAPIP());
}

void exitConfigMode() {
  if (!configMode) return;
  stopServers();
  dnsServer.stop();
  configMode = false;
  netBuf = "";
  allLampsOff();
}

void handleCommandLine(const String &line, const char *source) {
  String cmd = line;
  cmd.trim();
  if (cmd.length() == 0) return;

  recordRx(cmd);

  if (!hostHeard) {
    hostHeard = true;
    announceReady("first-cmd");
  }

  if (configMode) {

    const bool isDiag = cmd == "state?" || cmd == "state" || cmd == "wifi?" || cmd == "wifi" || cmd == "wifi clear";
    if (!isDiag) {
      Serial.print("ERR busy config-mode ");
      Serial.println(cmd);
      return;
    }
  }

  if (applyCommand(cmd)) {
    Serial.print("OK ");
    Serial.println(cmd);
  } else {
    Serial.print("ERR unknown ");
    Serial.println(cmd);
  }
  lastCommandMs = millis();
}

void replyNet(const String &text) {
  if (netClient != nullptr && netClient->connected()) {
    netClient->print(text);
    netClient->print("\r\n");
  }
}

bool drainNetLines() {
  bool got = false;
  while (netClient->available() > 0) {

    netInboundMs = millis();
    const char ch = (char)netClient->read();
    if (ch == '\n' || ch == '\r') {
      const String line = netBuf;
      netBuf = "";
      if (line.length() > 0) {
        got = true;

        if (configMode) {
          Serial.print("ERR busy config-mode ");
          Serial.println(line);
          replyNet(String("ERR busy config-mode ") + line);
          continue;
        }
        const bool ok = applyCommand(line);
        Serial.print(ok ? "OK " : "ERR unknown ");
        Serial.println(line);
        lastCommandMs = millis();
        replyNet(String(ok ? "OK " : "ERR unknown ") + line);
      }
    } else if (netBuf.length() < 64) {
      netBuf += ch;
    }
  }
  return got;
}

void dropNetClient(const char *why) {
  if (netClient == nullptr) return;
  Serial.print("TCP 客户端断开：");
  Serial.println(why);
  netClient->stop();
  delete netClient;
  netClient = nullptr;
  netAttached = false;
  netBuf = "";
}

void serviceNetClient() {
  if (netAttached) {
    if (netClient == nullptr || !netClient->connected()) {
      dropNetClient("对端已关闭");
      return;
    }
    drainNetLines();
    return;
  }

  WiFiClient c = netServer.available();
  if (!c) return;
  netClient = new WiFiClient(c);
  netAttached = true;
  netBuf = "";

  netInboundMs = millis();
  netProbeMs = netInboundMs;
  netProbeFail = 0;
  netClient->setNoDelay(true);
  Serial.print("TCP 客户端接入：");
  Serial.println(netClient->remoteIP());
}

void handleNetLiveness(uint32_t nowMs) {
  if (!netAttached || netClient == nullptr) return;

  const int avail = netClient->available();
  if (avail < 0) {
    dropNetClient("对端异常");
    return;
  }
  if (avail > 0) {

    netInboundMs = nowMs;
    netProbeFail = 0;
    return;
  }

  if (nowMs - netInboundMs < NET_PROBE_IDLE_MS) return;
  if (nowMs - netProbeMs < NET_PROBE_IDLE_MS) return;
  netProbeMs = nowMs;

  const size_t n = netClient->write("state?\n");
  if (n == 0) {

    netProbeFail++;
    if (netProbeFail >= 2) {
      dropNetClient("探针写不进去（半开连接）");
    }
  } else {
    netProbeFail = 0;
  }
}

void serviceNetwork(uint32_t nowMs) {
  if (configMode) return;
  if (WiFi.status() != WL_CONNECTED) return;
  serviceNetClient();
  handleNetLiveness(nowMs);

  const int sz = netUdp.parsePacket();
  if (sz <= 0) return;
  const IPAddress from = netUdp.remoteIP();
  const uint16_t fromPort = netUdp.remotePort();
  char buf[96];
  const int n = netUdp.read(buf, sizeof(buf) - 1);
  if (n <= 0) return;
  buf[n] = '\0';
  String line = String(buf);
  line.trim();
  if (line.length() == 0) return;
  const bool ok = applyCommand(line);
  Serial.print(ok ? "OK " : "ERR unknown ");
  Serial.println(line);
  lastCommandMs = millis();
  netUdp.beginPacket(from, fromPort);
  netUdp.print(ok ? "OK " : "ERR unknown ");
  netUdp.println(line);
  netUdp.endPacket();
}

void serviceWifiStatus(uint32_t nowMs) {

  if (usbMode) return;

  if (configMode) {
    webServer.handleClient();
    dnsServer.processNextRequest();

    if (scanRunning) {
      const int16_t n = WiFi.scanComplete();
      if (n != WIFI_SCAN_RUNNING || nowMs - scanStartedMs > 20000) {
        scanRunning = false;
      }
    }

    if (nowMs - lastConfigActivityMs > CONFIG_SESSION_MS) {
      Serial.println("配网模式空闲超时，退出并重试已存网络…");
      delay(200);
      markIntentionalRestart("config-mode idle timeout");
      ESP.restart();
    }
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    if (!netUp) {
      netUp = true;
      Serial.print("WiFi 已连接，IP：");
      Serial.println(WiFi.localIP());
      Serial.print("监听 TCP ");
      Serial.println(NET_PORT);
      netServer.begin();
      netUdp.begin(NET_PORT);
    }
    return;
  }

  if (netUp || connectPending) {
    netUp = false;
    netAttached = false;
    if (netClient != nullptr) {
      netClient->stop();
      delete netClient;
      netClient = nullptr;
    }
    connectPending = false;
    netServer.end();
    netUdp.stop();
    lastAttemptMs = nowMs;
    Serial.println("WiFi 断开，稍后重连…");
  }

  if (wifiSsid.length() == 0) {
    enterConfigMode();
    return;
  }

  if (nowMs - lastAttemptMs >= CONFIG_TIMEOUT_MS) {
    Serial.println("连不上已存 WiFi，进入配网模式");
    enterConfigMode();
    return;
  }

  if (nowMs - lastAttemptMs < WIFI_RETRY_MS) return;
  lastAttemptMs = nowMs;
  connectWifi();
}

void reportBootMode() {
  if (bootDiag.magic != BOOT_DIAG_MAGIC) return;
  const char *m = usbMode ? "usb" : "wifi";
  strncpy(bootDiag.lastMode, m, sizeof(bootDiag.lastMode) - 1);
  bootDiag.lastMode[sizeof(bootDiag.lastMode) - 1] = '\0';

  strncpy(bootDiag.resetText, resetReasonText(), sizeof(bootDiag.resetText) - 1);
  bootDiag.resetText[sizeof(bootDiag.resetText) - 1] = '\0';
}

void markIntentionalRestart(const char *why) {
  if (bootDiag.magic != BOOT_DIAG_MAGIC) return;
  strncpy(bootDiag.lastReason, why, sizeof(bootDiag.lastReason) - 1);
  bootDiag.lastReason[sizeof(bootDiag.lastReason) - 1] = '\0';
  const char *m = usbMode ? "usb" : "wifi";
  strncpy(bootDiag.lastMode, m, sizeof(bootDiag.lastMode) - 1);
  bootDiag.lastMode[sizeof(bootDiag.lastMode) - 1] = '\0';
  bootDiag.lastUptimeS = millis() / 1000;
}

const char *resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_UNKNOWN:    return "UNKNOWN 未确定";
    case ESP_RST_POWERON:    return "POWERON 上电";
    case ESP_RST_EXT:        return "EXT 外部复位脚";
    case ESP_RST_SW:         return "SW 软件重启(ESP.restart)";
    case ESP_RST_PANIC:      return "PANIC 程序异常";
    case ESP_RST_INT_WDT:    return "INT_WDT 中断看门狗";
    case ESP_RST_TASK_WDT:   return "TASK_WDT 任务看门狗";
    case ESP_RST_WDT:        return "WDT 其它看门狗";
    case ESP_RST_DEEPSLEEP:  return "DEEPSLEEP 深睡唤醒";
    case ESP_RST_BROWNOUT:   return "BROWNOUT 掉电(供电不足!)";
    case ESP_RST_SDIO:       return "SDIO";
    case ESP_RST_USB:        return "USB 外设复位";
    case ESP_RST_JTAG:       return "JTAG 复位";
    case ESP_RST_EFUSE:      return "EFUSE 错误";
    case ESP_RST_PWR_GLITCH: return "PWR_GLITCH 电源毛刺(供电不稳!)";
    case ESP_RST_CPU_LOCKUP: return "CPU_LOCKUP CPU 锁死";
    default:                 return "UNKNOWN 未覆盖的枚举值";
  }
}

const char *resetReasonText() {
  static char buf[56];
  snprintf(buf, sizeof(buf), "%s(%d)", resetReasonName(), (int)esp_reset_reason());
  return buf;
}

void reportResetReason() {
  const char *r = resetReasonText();

  rtcLost = (bootDiag.magic != BOOT_DIAG_MAGIC);
  if (rtcLost) {
    bootDiag.magic = BOOT_DIAG_MAGIC;
    bootDiag.boots = 0;
    bootDiag.lastMode[0] = '\0';
    bootDiag.lastReason[0] = '\0';
    bootDiag.lastUptimeS = 0;
    bootDiag.resetText[0] = '\0';
    bootDiag.prevResetText[0] = '\0';
  }
  bootDiag.boots++;

  strncpy(bootDiag.prevResetText, bootDiag.resetText, sizeof(bootDiag.prevResetText) - 1);
  bootDiag.prevResetText[sizeof(bootDiag.prevResetText) - 1] = '\0';

  recordResetHistory();

  Serial.printf("BOOT reset=%s bootCount=%lu rtcLost=%d\n",
                r, (unsigned long)bootDiag.boots, rtcLost ? 1 : 0);
  if (bootDiag.lastReason[0] != '\0') {
    Serial.printf("BOOT prev: mode=%s uptime=%lus reason=%s\n",
                  bootDiag.lastMode, (unsigned long)bootDiag.lastUptimeS, bootDiag.lastReason);
    Serial.printf("BOOT prev-reset: %s\n", bootDiag.resetText[0] ? bootDiag.resetText : "(未记录)");
    Serial.println("BOOT 短 uptime + 循环出现 = 正在重启环里，看上面的原因");
  } else {
    Serial.println("BOOT prev: (首次上电或上次没记录)");
  }
  if (rtcLost) {
    Serial.println("BOOT rtcLost=1 → RTC 诊断块无效 = 芯片经历过**完全断电**（不是普通复位）");
  }
  Serial.printf("BOOT NVS 历史（不受断电影响）: boots=%lu last=%s prev=%s\n",
                (unsigned long)nvsBootCount,
                nvsLastReset.length() ? nvsLastReset.c_str() : "(无)",
                nvsPrevReset.length() ? nvsPrevReset.c_str() : "(无)");
}

void recordResetHistory() {
  Preferences prefs;
  prefs.begin(NVS_DIAG_NS, false);
  const String last = prefs.getString("rstLast", "");
  const String prev = prefs.getString("rstPrev", "");
  const String now  = String(resetReasonText());
  nvsBootCount = prefs.getUInt("rstN", 0) + 1;

  prefs.putUInt("rstN", nvsBootCount);
  if (last != now) {
    prefs.putString("rstPrev", last);
    prefs.putString("rstLast", now);
    nvsLastReset = now;
    nvsPrevReset = last;
  } else {
    nvsLastReset = last;
    nvsPrevReset = prev;
  }
  prefs.end();
}

void announceReady(const char *why) {
  lastReadyMs = millis();
  readyResends++;

  Serial.printf(
      "ESP32_STATUS_LIGHT READY fw=%s via=%s reset=%s prev=%s boots=%lu rtcLost=%d nvsN=%lu nvsLast=%s rx=%s\n",
      FW_VERSION, why,
      bootDiag.resetText[0] ? bootDiag.resetText : resetReasonText(),
      bootDiag.prevResetText[0] ? bootDiag.prevResetText : "(未记录)",
      (unsigned long)bootDiag.boots, rtcLost ? 1 : 0,
      (unsigned long)nvsBootCount, nvsLastReset.length() ? nvsLastReset.c_str() : "(无)",
      lastRxCmd());
}

void serviceReadyAnnounce(uint32_t nowMs) {
  if (hostHeard) return;
  if (readyResends >= READY_RESEND_MAX) return;
  if (nowMs - lastReadyMs < READY_RESEND_MS) return;
  announceReady("idle");
}

bool waitForSerialInput(uint32_t ms) {
  const uint32_t start = millis();
  while (millis() - start < ms) {
    if (Serial.available() > 0) return true;
    delay(10);
  }
  return false;
}

bool readModeSwitchWifiPreferred() {
  const uint32_t began = millis();
  uint32_t stableSince = began;
  bool last = (digitalRead(PIN_CONFIG) == LOW);

  while (millis() - began < SWITCH_DEBOUNCE_MS * 20) {
    const bool now = (digitalRead(PIN_CONFIG) == LOW);
    if (now != last) {
      last = now;
      stableSince = millis();
    } else if (millis() - stableSince >= SWITCH_DEBOUNCE_MS) {
      return last;
    }
    delay(2);
  }

  return false;
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);

  reportResetReason();

  pinMode(PIN_CONFIG, INPUT_PULLUP);

  ledcAttach(PIN_YELLOW, PWM_FREQ, PWM_BITS);
  ledcAttach(PIN_GREEN,  PWM_FREQ, PWM_BITS);
  ledcAttach(PIN_RED,    PWM_FREQ, PWM_BITS);

  allLampsOff();
  writeLed(PIN_RED,    0);
  writeLed(PIN_YELLOW, 0);
  writeLed(PIN_GREEN,  0);

  Serial.printf("灯珠接法：%s  红=%u 黄=%u 绿=%u\n",
                ACTIVE_LOW ? "共阳（公共端 3V3，低电平点亮）"
                           : "共阴（公共端 GND，高电平点亮）",
                PIN_RED, PIN_YELLOW, PIN_GREEN);

  selfTest();

  switchRawAtBoot = (digitalRead(PIN_CONFIG) == LOW);
  switchWifiPreferred = readModeSwitchWifiPreferred();
  usbMode = !switchWifiPreferred;

  Serial.printf("模式开关：GPIO4=%s（%s偏好）→ 本次运行在 %s 模式\n",
                switchRawAtBoot ? "LOW 闭合" : "HIGH 断开",
                switchWifiPreferred ? "无线" : "有线",
                usbMode ? "有线(串口)" : "无线(WiFi)");

  reportBootMode();

  const bool haveCreds = loadWifiCreds();

  loadPowerSettings();
  applyPowerSettings();

  if (usbMode) {

    WiFi.mode(WIFI_OFF);
    Serial.println("有线模式：走串口，WiFi 已关闭");
  } else if (haveCreds) {
    connectWifi();
    const uint32_t t0 = millis();

    while (WiFi.status() != WL_CONNECTED && millis() - t0 < SETUP_WIFI_WAIT_MS) {
      if (waitForSerialInput(250)) break;
      Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      netUp = true;
      Serial.print("WiFi 已连接，IP：");
      Serial.println(WiFi.localIP());
      netServer.begin();
      netUdp.begin(NET_PORT);
    } else {
      Serial.println("连不上，进入配网模式");
      enterConfigMode();
    }
  } else {
    Serial.println("未保存 WiFi 凭据");
    enterConfigMode();
  }

  announceReady("boot");

  lastCommandMs = millis();

  lastLoopMs = 0;
  maxLoopMs = 0;
  stallCount = 0;
}

bool trySerialWifiConfig(const String &line) {
  if (!line.startsWith("wifi ")) return false;

  const String arg = line.substring(5);
  const int sp = arg.indexOf(' ');
  if (sp <= 0) return false;

  String ssid = arg.substring(0, sp);
  String pass = arg.substring(sp + 1);
  ssid.trim();
  pass.trim();

  if (ssid.length() == 0 || ssid.length() > 32 || pass.length() > 64) {
    Serial.println("ERR wifi 参数不合法（SSID 1-32 字节，密码 ≤64 字节）");
    return true;
  }

  saveWifiCreds(ssid, pass);
  Serial.print("OK wifi saved ");
  Serial.println(ssid);
  Serial.println("重启后连接…");
  delay(400);
  markIntentionalRestart("serial wifi config");
  ESP.restart();
  return true;
}

void loop() {
  uint32_t now = millis();
  loopCount++;

  static uint32_t prevLoopMs = 0;
  if (prevLoopMs == 0) {
    prevLoopMs = now;
  } else {
    lastLoopMs = now - prevLoopMs;
    prevLoopMs = now;
    if (lastLoopMs > maxLoopMs) maxLoopMs = lastLoopMs;
    if (lastLoopMs > 100) stallCount++;
  }

  static String buffer = "";
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (buffer.length() > 0) {
        String line = buffer;
        buffer = "";
        line.trim();
        if (line.length() > 0) {
          if (!trySerialWifiConfig(line)) handleCommandLine(line, "serial");
        }
      }
    } else if (buffer.length() < 64) {
      buffer += c;
    }
  }

  serviceNetwork(now);

  serviceWifiStatus(now);

  checkModeSwitch(now);

  serviceReadyAnnounce(now);

  if (configMode) {
    renderConfigLamp(now);
    delay(5);
    return;
  }

  if (notifyActive) {
    const uint32_t totalMs = (uint32_t)(NOTIFY_ON_MS + NOTIFY_OFF_MS) * NOTIFY_BLINKS;
    const uint32_t nowNotify = millis();
    if ((uint32_t)(nowNotify - notifyStartMs) >= totalMs) {
      notifyActive = false;
      String target = notifyAfter;
      if (target.length() == 0) target = savedState;
      if (target.length() > 0) {
        applyCommand(target);
        Serial.print("OK notify -> ");
        Serial.println(target);
      } else {
        Serial.println("OK notify -> (kept current)");
      }
    } else {
      const uint32_t phase = (uint32_t)(nowNotify - notifyStartMs) % (NOTIFY_ON_MS + NOTIFY_OFF_MS);
      const uint16_t g = (phase < NOTIFY_ON_MS) ? PWM_MAX : 0;
      writeLed(PIN_GREEN, g);
      writeLed(PIN_YELLOW, 0);
      writeLed(PIN_RED, 0);
      delay(5);
      return;
    }
  }

  if (currentState != "off" && (int32_t)(now - lastCommandMs) > (int32_t)STALE_TIMEOUT_MS) {
    currentState = "off";
    allLampsOff();
    resetTools();
  }

  updateToolsEffect(millis());

  writeLed(PIN_YELLOW, renderLamp(lampYellow, now));
  writeLed(PIN_GREEN,  renderLamp(lampGreen,  now));
  writeLed(PIN_RED,    renderLamp(lampRed,    now));

  delay(5);
}

void checkModeSwitch(uint32_t nowMs) {

  static uint32_t lastPollMs = 0;
  if (nowMs - lastPollMs < SWITCH_POLL_MS) return;
  lastPollMs = nowMs;

  const bool wantWifi = readModeSwitchWifiPreferred();
  if (wantWifi == switchWifiPreferred) return;

  switchWifiPreferred = wantWifi;
  Serial.println();
  Serial.printf("模式开关拨动 → 切到%s模式，重启…\n", wantWifi ? "无线(WiFi)" : "有线(串口)");
  delay(200);
  markIntentionalRestart(wantWifi ? "switch->wireless" : "switch->wired");
  ESP.restart();
}
