#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>

#include <esp_system.h>
#include <esp_arduino_version.h>
#include "status_logic.h"

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

const char *FW_VERSION = "2.1.1";

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

statuslight::Notification<String> notification;
bool &notifyActive = notification.active;
uint32_t &notifyStartMs = notification.began;
String &notifyAfter = notification.after;
String &savedState = notification.saved;

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
bool     configRoutesRegistered = false;
uint32_t scanStartedMs = 0;
statuslight::RetryClock wifiRetry;
volatile uint16_t lastWifiDisconnectReason = 0;
uint16_t reportedWifiDisconnectReason = 0;
bool wifiConfigPending = false;
uint32_t wifiConfigApplyMs = 0;

bool usbMode = false;

bool switchWifiPreferred = false;

bool switchRawAtBoot = false;

const uint32_t SWITCH_DEBOUNCE_MS = 50;

void reportResetReason();
void reportBootMode();
const char *resetReasonText();
void recordBootStage(const char *stage);

void announceReady(const char *why);
void announceReady(const char *why, Print &output);
bool applyCommand(const String &raw, Print &output, bool allowManagement);

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
  char     lastStage[24];
} bootDiag;

const uint32_t BOOT_DIAG_MAGIC = 0xD5C3E502u;

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

void printRxLog(Print &output) {
  output.print("RX(");
  output.print(rxLogCount);
  output.print(")");
  const uint8_t start = (rxLogCount < RX_LOG_MAX) ? 0 : rxLogNext;
  for (uint8_t i = 0; i < rxLogCount; i++) {
    const RxLogEntry &e = rxLog[(start + i) % RX_LOG_MAX];
    output.print(' ');
    output.print(e.cmd);
    output.print('@');
    output.print(e.ms);
    if (i + 1 < rxLogCount) output.print('|');
  }
  output.println();
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
String   previousBootStage = "unknown";

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

const uint32_t NET_CLIENT_IDLE_MS = 90000;

uint8_t  cfgTxPowerDbm = 13;

uint8_t  cfgConfigTxDbm = 8;
// Brownout protection is owned by ESP-IDF startup; never register it again.

const int8_t TX_POWER_CHOICES_DBM[] = {20, 13, 8, 5, 2};
const size_t TX_POWER_CHOICE_COUNT  = sizeof(TX_POWER_CHOICES_DBM) / sizeof(TX_POWER_CHOICES_DBM[0]);

void applyPowerSettings();

WebServer webServer(80);
DNSServer dnsServer;
WiFiServer netServer(NET_PORT);
WiFiUDP   netUdp;

const char CONFIG_PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 状态灯配网</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;padding:0 18px;color:#222;background:#f5f5f7}section{background:white;padding:18px;border-radius:12px;margin:16px 0}label{display:block;margin-top:14px}input,button{width:100%;box-sizing:border-box;padding:11px;margin-top:6px}button{cursor:pointer}td{padding:5px}#status{white-space:pre-wrap}</style>
</head><body><h1>DSH 状态灯</h1><p>选择 2.4GHz Wi-Fi，保存后立即连接。</p>
<section><form id="wifi-form"><label for="ssid">Wi-Fi 名称</label><input id="ssid" required autocomplete="off">
<div id="net-results" hidden><p>扫描结果（点按名称填入）</p><div id="nets" style="max-height:240px;overflow:auto"></div></div>
<label for="pass">密码</label><input id="pass" type="password" autocomplete="new-password">
<button id="scanbtn" type="button">扫描附近 Wi-Fi</button><button type="submit">保存并连接</button></form><p id="status" role="status"></p></section>
<section><p>固件 2.1.1 · 配网发射功率 8 dBm</p><button id="info" type="button">读取诊断信息</button><pre id="diagnostics"></pre><button id="forget" type="button">清除 Wi-Fi 凭据</button></section>
<script>
const status=document.getElementById('status'), scanbtn=document.getElementById('scanbtn');
document.getElementById('info').onclick=async function(){
  try{const r=await fetch('/info',{cache:'no-store'});document.getElementById('diagnostics').textContent=JSON.stringify(await r.json(),null,2);}
  catch(e){status.textContent='读取失败，请重新连接配网热点。';}
};
scanbtn.onclick=async function(){
  scanbtn.disabled=true;scanbtn.textContent='扫描中…';
  try{
    await fetch('/scan',{cache:'no-store'});
    for(let i=0;i<50;i++){
      await new Promise(r=>setTimeout(r,400));
      const r=await fetch('/scanresult',{cache:'no-store'}), data=await r.json();
      if(data.scanning)continue;
      const list=document.getElementById('nets');list.replaceChildren();
      const names=[...new Set(data)].filter(name=>typeof name==='string'&&name.length);
      for(const name of names){
        const button=document.createElement('button');button.type='button';button.value=name;button.textContent=name;
        button.onclick=function(){document.getElementById('ssid').value=name;status.textContent='已选择：'+name;};
        list.appendChild(button);
      }
      document.getElementById('net-results').hidden=!names.length;
      status.textContent=names.length?'找到 '+names.length+' 个网络，请点按列表中的名称。':'没有发现网络，可直接填写名称。';return;
    }
    throw new Error('扫描超时，请重试');
  }catch(e){status.textContent=e.message;}
  finally{scanbtn.disabled=false;scanbtn.textContent='扫描附近 Wi-Fi';}
};
document.getElementById('wifi-form').onsubmit=async function(e){
  e.preventDefault();
  try{
    const r=await fetch('/save',{method:'POST',body:new URLSearchParams({ssid:document.getElementById('ssid').value,pass:document.getElementById('pass').value})});
    status.textContent=r.ok?'已保存，正在连接。配网热点将关闭，请回到手机热点所在网络。':await r.text();
  }catch(e){status.textContent='连接已中断，请查看状态灯或重新连接配网热点。';}
};
document.getElementById('forget').onclick=async function(){
  if(!confirm('清除 Wi-Fi 凭据？'))return;
  try{const r=await fetch('/forget',{method:'POST'});status.textContent=r.ok?'凭据已清除，请重新配网。':await r.text();}
  catch(e){status.textContent='请重新连接配网热点。';}
};
</script></body></html>)HTML";

#ifdef DSH_MINIMAL_CONFIG_PAGE
const char MINIMAL_CONFIG_PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 最小配网页</title><h1>DSH 最小配网页</h1>
<form method="post" action="/save"><p>2.4GHz Wi-Fi 名称 <input name="ssid" required></p>
<p>密码 <input name="pass" type="password"></p><button>保存并连接</button></form>
<p><a href="/info">读取诊断信息</a></p></html>)HTML";
#endif

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

bool applyCommand(const String &raw, Print &output, bool allowManagement) {
  String cmd = raw;
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return false;
  if (!allowManagement && !(statuslight::isStateCommand(cmd) || cmd == "hello" || cmd == "ping" ||
      cmd == "state?" || cmd == "state" || cmd == "wifi?" || cmd == "wifi" ||
      cmd == "mode" || cmd == "power" || cmd.startsWith("tools ") || cmd == "notify" || cmd.startsWith("notify "))) {
    output.println("ERR management requires USB serial");
    return false;
  }
  if (cmd == "hello") {
    hostHeard = true;
    announceReady("hello", output);
    return true;
  }
  if (cmd == "ping") return true;

  if (cmd == "state?" || cmd == "state") {
    output.print("STATE ");
    output.print(currentState);
    output.print(" | plan=");
    output.print(currentState.endsWith("+plan") ? 1 : 0);
    output.print(" tools=");
    output.print(toolsActive ? 1 : 0);
    output.print(" notify=");
    output.print(notifyActive ? 1 : 0);
    output.print(" saved=");
    output.print(savedState.length() == 0 ? "<none>" : savedState);
    output.print(" after=");
    output.print(notifyAfter.length() == 0 ? "<none>" : notifyAfter);
    output.print(" savedcleared=");
    output.print(savedClearedCount);
    output.print(" loops=");
    output.print(loopCount);
    output.print(" lastloop=");
    output.print(lastLoopMs);
    output.print(" maxloop=");
    output.print(maxLoopMs);
    output.print(" stalls=");
    output.print(stallCount);
    output.print(" now=");
    output.println(millis());

    output.print("LAMPS Y=");
    output.print(effectName(lampYellow.effect));
    output.print(" G=");
    output.print(effectName(lampGreen.effect));
    output.print(" R=");
    output.print(effectName(lampRed.effect));

    output.print(" pol=");
    output.println(ACTIVE_LOW ? "active-low" : "active-high");

    printRxLog(output);
    return true;
  }

  if (cmd == "power" || cmd.startsWith("power ")) {
    String arg = cmd.length() > 6 ? cmd.substring(6) : String("");
    arg.trim();

    if (arg.length() == 0) {
      output.print("POWER tx=");
      output.print(cfgTxPowerDbm);
      output.print("dBm bod=");
      output.print("on (framework)");
      output.print(" choices=");
      for (size_t i = 0; i < TX_POWER_CHOICE_COUNT; i++) {
        if (i) output.print("/");
        output.print(TX_POWER_CHOICES_DBM[i]);
      }
      output.println();
      return true;
    }

    if (arg.startsWith("tx ")) {
      const int want = arg.substring(3).toInt();
      bool ok = false;
      for (size_t i = 0; i < TX_POWER_CHOICE_COUNT; i++) {
        if (TX_POWER_CHOICES_DBM[i] == want) { ok = true; break; }
      }
      if (!ok) {
        output.println("ERR power tx 只认 20/13/8/5/2 (dBm)");
        return true;
      }
      cfgTxPowerDbm = (uint8_t)want;
      savePowerSettings();
      applyPowerSettings();
      output.print("OK power tx=");
      output.print(cfgTxPowerDbm);
      output.println("dBm（发射电流峰值随之下调）");
      return true;
    }

    if (arg == "bod on") {
      output.println("POWER brownout protection is managed by the framework");
      return true;
    }
    if (arg.startsWith("bod ")) {
      output.println("ERR brownout protection cannot be disabled");
      return false;
    }

    output.println("ERR power 只认 tx <n> / bod <on|off>");
    return true;
  }

  if (cmd == "wifi?" || cmd == "wifi") {
    output.print("WIFI mode=");
    output.print(usbMode ? "usb" : "wifi");
    output.print(" ssid=");
    output.print(wifiSsid.length() == 0 ? "<none>" : wifiSsid);
    output.print(" saved=");
    output.print(wifiSsid.length() == 0 ? 0 : 1);
    output.print(" state=");
    output.print(configMode ? "config" : (WiFi.status() == WL_CONNECTED ? "connected" : "idle"));
    output.print(" ip=");
    output.print(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString()
                                               : (configMode ? WiFi.softAPIP().toString() : String("<none>")));
    output.print(" rssi=");
    output.print(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0);
    output.print(" tcp=");
    output.print(netAttached ? 1 : 0);

    output.print(" sw=");
    output.print(switchWifiPreferred ? 1 : 0);
    output.print(" swBoot=");
    output.print(switchRawAtBoot ? 1 : 0);
    output.print(" netTalkAge=");
    output.print(netInboundMs == 0 ? 0 : millis() - netInboundMs);

    output.print(" tx=");
    output.print(cfgTxPowerDbm);
    output.print("dBm bod=");
    output.print("on (framework)");
    output.print(" scanning=");
    output.print(scanRunning ? 1 : 0);
    output.print(" scanResult=");
    output.print(WiFi.scanComplete());
    output.print(" port=");
    output.println(NET_PORT);
    return true;
  }

  if (cmd.startsWith("wifi ")) {
    String arg = cmd.substring(5);
    arg.trim();

    if (arg == "clear") {
      clearWifiCreds();
      output.println("OK wifi credentials cleared");
      wifiConfigPending = true;
      wifiConfigApplyMs = millis() + 100;
      return true;
    }

    return false;
  }

  if (cmd == "mode" || cmd.startsWith("mode ")) {
    output.print("MODE current=");
    output.print(usbMode ? "usb" : "wifi");
    output.print(" switch=");
    output.print(switchWifiPreferred ? "closed(wifi)" : "open(wired)");
    output.print(" switchBoot=");
    output.println(switchRawAtBoot ? 1 : 0);
    if (cmd.length() > 5) {
      output.println("MODE 只读：模式由 GPIO4 拨动开关决定，请拨开关而不是敲命令");
    }
    return true;
  }

  if (cmd == "notify" || cmd.startsWith("notify ")) {
    String after = "";
    if (cmd.length() > 7) {
      after = cmd.substring(7);
      after.trim();
    }
    if (after.length() && !statuslight::isStateCommand(after)) return false;
    notification.begin(currentState, after, millis());
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

  if (notification.stateChanged(nextState, currentState)) savedClearedCount++;

  currentState = nextState;

  if (canon == "off" || canon == "error" || canon == "alarm" || canon == "success") {
    resetTools();
  }

  applyStateEffects(nextState);
  return true;
}

bool applyCommand(const String &raw) { return applyCommand(raw, Serial, true); }

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

String configApPassword() {
  Preferences prefs;
  prefs.begin(NVS_NS, false);
  String password = prefs.getString("apPass", "");
#ifdef DSH_CONFIG_AP_PASSWORD
  const String buildPassword = DSH_CONFIG_AP_PASSWORD;
  if (password != buildPassword) { password = buildPassword; prefs.putString("apPass", password); }
#endif
  if (password.length() != 12) {
    const char alphabet[] = "abcdefghijkmnpqrstuvwxyz23456789";
    password = "";
    for (unsigned i = 0; i < 12; ++i) password += alphabet[esp_random() % (sizeof(alphabet) - 1)];
    prefs.putString("apPass", password);
  }
  prefs.end();
  return password;
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
  wifiSsid = ssid;
  wifiPass = pass;
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
  if (WiFi.getMode() == WIFI_OFF) return;
  const uint8_t dbm = configMode ? cfgConfigTxDbm : cfgTxPowerDbm;
  if (!WiFi.setTxPower((wifi_power_t)(dbm * 4))) {
    Serial.println("WIFI tx-power apply failed");
  } else {
    Serial.printf("WIFI tx=%udBm actual-quarter-dBm=%d\n", dbm, (int)WiFi.getTxPower());
  }
}

void loadPowerSettings() {
  Preferences prefs;
  prefs.begin(NVS_NS, true);
  cfgTxPowerDbm = prefs.getUChar("txp", 13);
  bool valid = false;
  for (size_t i = 0; i < TX_POWER_CHOICE_COUNT; i++) if (TX_POWER_CHOICES_DBM[i] == cfgTxPowerDbm) valid = true;
  if (!valid) cfgTxPowerDbm = 13;
  // Ignore the old "bod" preference; framework brownout detection stays enabled.
  prefs.end();
}

void savePowerSettings() {
  Preferences prefs;
  prefs.begin(NVS_NS, false);
  prefs.putUChar("txp", cfgTxPowerDbm);
  prefs.remove("bod");
  prefs.end();
}

void stopServers() {
  if (netClient != nullptr) { netClient->stop(); delete netClient; netClient = nullptr; }
  netAttached = false;
  netBuf = "";
  netServer.end();
  netUdp.stop();
  webServer.stop();
}

void connectWifi() {
  if (wifiSsid.length() == 0 || usbMode) return;
  recordBootStage("wifi-init");
  if (WiFi.getMode() != WIFI_STA) WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  WiFi.setSleep(true);
  applyPowerSettings();
  recordBootStage("wifi-begin");
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  wifiRetry.attempted(millis());
  Serial.println("WIFI connecting (credentials redacted)");
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
  wifiRetry.connected();

  recordBootStage("config-ap");
  WiFi.mode(WIFI_AP); // Scanning enables STA only when the user asks to scan.
  applyPowerSettings();
  const String apPassword = configApPassword();
  if (!WiFi.softAP(apName().c_str(), apPassword.c_str(), 1, 0, 1)) Serial.println("ERR config AP start failed");
  // User-visible credential; redact this line when sharing a diagnostic capture.
  Serial.printf("CONFIG AP=%s password=%s\n", apName().c_str(), apPassword.c_str());
  dnsServer.start(53, "*", WiFi.softAPIP());

  if (!configRoutesRegistered) {
  configRoutesRegistered = true;
  webServer.on("/", []() {
    lastConfigActivityMs = millis();
    recordBootStage("config-http-send");
#ifdef DSH_MINIMAL_CONFIG_PAGE
    webServer.send_P(200, "text/html; charset=utf-8", MINIMAL_CONFIG_PAGE);
#else
    webServer.send_P(200, "text/html; charset=utf-8", CONFIG_PAGE);
#endif
    recordBootStage("config-http-done");
  });

  webServer.on("/info", []() {
    lastConfigActivityMs = millis();
    String json = "{\"name\":" + statuslight::jsonQuote(apName());
    json += ",\"fw\":" + statuslight::jsonQuote(String(FW_VERSION));
    json += ",\"reset\":" + statuslight::jsonQuote(String(resetReasonText()));
    json += ",\"previousReset\":" + statuslight::jsonQuote(String(bootDiag.prevResetText));
    json += ",\"previousStage\":" + statuslight::jsonQuote(previousBootStage);
    json += ",\"saved\":" + statuslight::jsonQuote(wifiSsid.length() ? String("已保存: ") + wifiSsid : String("无"));
    json += ",\"boots\":" + String(nvsBootCount);
    json += ",\"heap\":" + String(ESP.getFreeHeap()) + "}";
    webServer.send(200, "application/json; charset=utf-8", json);
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

  webServer.on("/save", HTTP_POST, []() {
    lastConfigActivityMs = millis();
    const String ssid = webServer.arg("ssid");
    const String pass = webServer.arg("pass");
    if (ssid.length() == 0 || ssid.length() > 32 || pass.length() > 64) {
      webServer.send(400, "text/plain; charset=utf-8", "SSID须为1–32字节，密码最多64字节");
      return;
    }
    saveWifiCreds(ssid, pass);
    webServer.send(200, "text/html; charset=utf-8",
                   "<!doctype html><meta charset='utf-8'><body style='font-family:sans-serif;padding:24px'>"
                   "<h3>已保存，正在连接…</h3><p>板子会连上 " + statuslight::htmlEscape(ssid) + "。连接成功后热点关闭，无需整机重启。</p></body>");
    wifiConfigPending = true;
    wifiConfigApplyMs = millis() + 200;
  });

  webServer.on("/forget", HTTP_POST, []() {
    lastConfigActivityMs = millis();
    clearWifiCreds();
    webServer.send(200, "text/html; charset=utf-8",
                   "<!doctype html><meta charset='utf-8'><body style='font-family:sans-serif;padding:24px'>"
                   "<h3>凭据已清除，请重新配网。</h3></body>");
    wifiConfigPending = true;
    wifiConfigApplyMs = millis() + 200;
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
    const String json = statuslight::ssidListJson<String>(n, [](int i) { return WiFi.SSID(i); });

    WiFi.scanDelete();
    webServer.send(200, "application/json", json);
  });

  webServer.onNotFound([]() {
    webServer.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
    webServer.send(302, "text/plain", "");
  });
  }

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
  WiFi.softAPdisconnect(true);
  configMode = false;
  netBuf = "";
  applyStateEffects(currentState);
}

void handleCommandLine(const String &line, const char *source) {
  String cmd = line;
  cmd.trim();
  if (cmd.length() == 0) return;

  recordRx(cmd);

  if (!hostHeard && cmd != "hello") {
    hostHeard = true;
    announceReady("first-cmd");
  }

  if (configMode) {

    const bool isDiag = cmd == "hello" || cmd == "ping" || cmd == "state?" || cmd == "state" || cmd == "wifi?" || cmd == "wifi" || cmd == "wifi clear" || cmd.startsWith("power");
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
  if (statuslight::isStateCommand(cmd) || cmd == "hello" || cmd == "ping" || cmd.startsWith("tools ") || cmd.startsWith("notify") || cmd == "state?" || cmd == "wifi?") lastCommandMs = millis();
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
        recordRx(line);
        const bool ok = applyCommand(line, *netClient, false);
        Serial.print(ok ? "OK " : "ERR unknown ");
        Serial.println(line);
        if (ok) lastCommandMs = millis();
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
  netClient->setNoDelay(true);
  Serial.print("TCP 客户端接入：");
  Serial.println(netClient->remoteIP());
}

void handleNetLiveness(uint32_t nowMs) {
  if (netAttached && netClient != nullptr && (uint32_t)(nowMs - netInboundMs) >= NET_CLIENT_IDLE_MS) {
    dropNetClient("application heartbeat timeout");
  }
}

void serviceNetwork(uint32_t nowMs) {
  if (configMode) return;
  if (WiFi.status() != WL_CONNECTED) return;
  serviceNetClient();
  handleNetLiveness(millis());

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
  if (sz >= (int)sizeof(buf)) { netUdp.clear(); return; }
  netUdp.beginPacket(from, fromPort);
  recordRx(line);
  const bool ok = applyCommand(line, netUdp, false);
  Serial.print(ok ? "OK " : "ERR unknown ");
  Serial.println(line);
  if (ok) lastCommandMs = millis();
  netUdp.print(ok ? "OK " : "ERR unknown ");
  netUdp.println(line);
  netUdp.endPacket();
}

void serviceWifiStatus(uint32_t nowMs) {
  nowMs = millis();
  if (wifiConfigPending && (int32_t)(nowMs - wifiConfigApplyMs) >= 0) {
    wifiConfigPending = false;
    exitConfigMode();
    stopServers();
    netUp = false;
    wifiRetry.connected();
    if (!usbMode) {
      if (wifiSsid.length()) connectWifi();
      else enterConfigMode();
    }
    return;
  }
  if (usbMode) return;
  if (lastWifiDisconnectReason != reportedWifiDisconnectReason) {
    reportedWifiDisconnectReason = lastWifiDisconnectReason;
    Serial.printf("WIFI disconnect reason=%u heap=%lu\n", reportedWifiDisconnectReason, (unsigned long)ESP.getFreeHeap());
  }
  if (configMode) {
    webServer.handleClient();
    dnsServer.processNextRequest();
    // HTTP handlers may record a newer timestamp than loop() supplied. Sample
    // again before unsigned subtraction, otherwise a 1 ms skew looks like 49 days.
    nowMs = millis();
    if (scanRunning && (WiFi.scanComplete() != WIFI_SCAN_RUNNING || (uint32_t)(nowMs - scanStartedMs) > 20000)) scanRunning = false;
    if ((uint32_t)(nowMs - lastConfigActivityMs) > CONFIG_SESSION_MS) {
      lastConfigActivityMs = nowMs;
      if (wifiSsid.length()) { exitConfigMode(); connectWifi(); }
    }
    return;
  }
  if (WiFi.status() == WL_CONNECTED) {
    wifiRetry.connected();
    if (!netUp) {
      netUp = true;
      recordBootStage("wifi-connected");
      Serial.print("WIFI connected IP=");
      Serial.println(WiFi.localIP());
      netServer.begin();
      netUdp.begin(NET_PORT);
    }
    return;
  }
  if (netUp) { netUp = false; stopServers(); }
  if (!wifiSsid.length()) { enterConfigMode(); return; }
  switch (wifiRetry.next(nowMs, WIFI_RETRY_MS, CONFIG_TIMEOUT_MS)) {
    case statuslight::RetryAction::Connect: connectWifi(); break;
    case statuslight::RetryAction::Configure: enterConfigMode(); break;
    case statuslight::RetryAction::Wait: break;
  }
}

void reportBootMode() {
  if (bootDiag.magic != BOOT_DIAG_MAGIC) return;
  const char *m = usbMode ? "usb" : "wifi";
  strncpy(bootDiag.lastMode, m, sizeof(bootDiag.lastMode) - 1);
  bootDiag.lastMode[sizeof(bootDiag.lastMode) - 1] = '\0';

  strncpy(bootDiag.resetText, resetReasonText(), sizeof(bootDiag.resetText) - 1);
  bootDiag.resetText[sizeof(bootDiag.resetText) - 1] = '\0';
}

void recordBootStage(const char *stage) {
  if (bootDiag.magic == BOOT_DIAG_MAGIC) {
    strncpy(bootDiag.lastStage, stage, sizeof(bootDiag.lastStage) - 1);
    bootDiag.lastStage[sizeof(bootDiag.lastStage) - 1] = '\0';
    bootDiag.lastUptimeS = millis() / 1000;
  }
  Serial.printf("BOOT stage=%s heap=%lu\n", stage, (unsigned long)ESP.getFreeHeap());
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
    bootDiag.lastStage[0] = '\0';
  }
  previousBootStage = bootDiag.lastStage[0] ? bootDiag.lastStage : "unknown";
  bootDiag.boots++;
  Serial.printf("BOOT previous-stage=%s previous-uptime=%lus core=%s brownout=framework-default\n",
                bootDiag.lastStage[0] ? bootDiag.lastStage : "unknown",
                (unsigned long)bootDiag.lastUptimeS, ESP_ARDUINO_VERSION_STR);
  bootDiag.lastReason[0] = '\0';

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
    Serial.println("BOOT rtcLost=1: RTC diagnostic block invalid; power loss is one possible cause");
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

void announceReady(const char *why, Print &output) {
  lastReadyMs = millis();
  readyResends++;
  output.printf("ESP32_STATUS_LIGHT READY fw=%s via=%s mode=%s config=%d reset=%s prev=%s boots=%lu rtcLost=%d stage=%s nvsN=%lu\n",
      FW_VERSION, why, usbMode ? "usb" : "wifi", configMode ? 1 : 0,
      resetReasonText(), bootDiag.prevResetText[0] ? bootDiag.prevResetText : "unknown",
      (unsigned long)bootDiag.boots, rtcLost ? 1 : 0, bootDiag.lastStage, (unsigned long)nvsBootCount);
}
void announceReady(const char *why) { announceReady(why, Serial); }

void serviceReadyAnnounce(uint32_t nowMs) {
  if (hostHeard) return;
  if (readyResends >= READY_RESEND_MAX) return;
  if (nowMs - lastReadyMs < READY_RESEND_MS) return;
  announceReady("idle");
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

  const bool yellowPwm = ledcAttach(PIN_YELLOW, PWM_FREQ, PWM_BITS);
  const bool greenPwm = ledcAttach(PIN_GREEN, PWM_FREQ, PWM_BITS);
  const bool redPwm = ledcAttach(PIN_RED, PWM_FREQ, PWM_BITS);
  if (!yellowPwm || !greenPwm || !redPwm) Serial.println("ERR PWM initialization failed");

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
  WiFi.onEvent([](arduino_event_id_t event, arduino_event_info_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) lastWifiDisconnectReason = info.wifi_sta_disconnected.reason;
  });
  if (usbMode) {
    WiFi.mode(WIFI_OFF);
    recordBootStage("usb-running");
  } else if (haveCreds) {
    connectWifi();
  } else {
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

  if (ssid.length() == 0 || ssid.length() > 32 || pass.length() > 64) {
    Serial.println("ERR wifi 参数不合法（SSID 1-32 字节，密码 ≤64 字节）");
    return true;
  }

  saveWifiCreds(ssid, pass);
  Serial.print("OK wifi saved ");
  Serial.println(ssid);
  wifiConfigPending = true;
  wifiConfigApplyMs = millis() + 100;
  Serial.println(usbMode ? "Credentials stored; select WiFi mode to connect" : "Connecting without restarting");
  return true;
}

void loop() {
  uint32_t now = millis();
  loopCount++;
  bootDiag.lastUptimeS = now / 1000;

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
  static bool bufferOverflow = false;
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (bufferOverflow) { buffer = ""; bufferOverflow = false; Serial.println("ERR command too long"); continue; }
      if (buffer.length() > 0) {
        String line = buffer;
        buffer = "";
        if (line.length() > 0) {
          if (!trySerialWifiConfig(line)) handleCommandLine(line, "serial");
        }
      }
    } else if (buffer.length() < 128) {
      buffer += c;
    } else {
      bufferOverflow = true;
    }
  }

  now = millis();
  serviceNetwork(now);

  serviceWifiStatus(now);

  now = millis();
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
      String target;
      notification.complete(nowNotify, totalMs, target);
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
  static bool candidate = switchWifiPreferred;
  static uint32_t changedAt = 0;
  const bool raw = digitalRead(PIN_CONFIG) == LOW;
  if (raw != candidate) { candidate = raw; changedAt = nowMs; return; }
  if (candidate == switchWifiPreferred || (uint32_t)(nowMs - changedAt) < SWITCH_DEBOUNCE_MS) return;
  switchWifiPreferred = candidate;
  exitConfigMode();
  stopServers();
  netUp = false;
  wifiRetry.connected();
  usbMode = !candidate;
  reportBootMode();
  if (usbMode) {
    WiFi.mode(WIFI_OFF);
    recordBootStage("usb-running");
  } else if (wifiSsid.length()) {
    connectWifi();
  } else {
    enterConfigMode();
  }
  announceReady("mode-change");
}
