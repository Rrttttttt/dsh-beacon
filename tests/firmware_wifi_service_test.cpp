#include <cassert>
#include <cstdint>
#include <functional>
#include <iostream>
#include <string>
#include "../firmware/esp32c3_dsh_status_light/status_logic.h"

// Execute the actual serviceWifiStatus() body extracted from the sketch, with
// deterministic HTTP callbacks and a fake clock. No ESP32 hardware is simulated.
uint32_t fakeNow = 0;
uint32_t millis() { return fakeNow; }
void delay(unsigned ms) { fakeNow += ms; }
struct {
  int restarts = 0;
  void restart() { ++restarts; }
  unsigned getFreeHeap() { return 100000; }
} ESP;
struct {
  template<class... T> void print(T...) {}
  template<class... T> void println(T...) {}
  template<class... T> void printf(T...) {}
} Serial;
constexpr int WIFI_SCAN_RUNNING = -1, WL_CONNECTED = 3;
struct {
  int scanComplete() { return WIFI_SCAN_RUNNING; }
  int status() { return 0; }
  int localIP() { return 0; }
} WiFi;
struct {
  std::function<void()> request;
  void handleClient() { if (request) request(); }
} webServer;
struct { void processNextRequest() {} } dnsServer;
struct { void begin() {} void end() {} } netServer;
struct { void begin(unsigned) {} void stop() {} } netUdp;
struct Client { void stop() {} };
Client *netClient = nullptr;
std::string wifiSsid;
std::string wifiPass;
using String = std::string;
constexpr const char *NVS_NS = "dsh-led";
struct Preferences {
  void begin(const char *, bool) {}
  void putString(const char *, const std::string &) {}
  void end() {}
};
bool configMode = true, usbMode = false, scanRunning = false;
bool netUp = false, netAttached = false, connectPending = false, wifiConfigPending = false;
uint32_t lastConfigActivityMs = 0, scanStartedMs = 0, lastAttemptMs = 0, wifiConfigApplyMs = 0;
uint16_t lastWifiDisconnectReason = 0, reportedWifiDisconnectReason = 0;
constexpr uint32_t CONFIG_SESSION_MS = 600000, CONFIG_TIMEOUT_MS = 15000, WIFI_RETRY_MS = 5000;
constexpr uint16_t NET_PORT = 8234;
statuslight::RetryClock wifiRetry;
int exits = 0, connections = 0;
void exitConfigMode() { configMode = false; ++exits; }
void connectWifi() { ++connections; }
void enterConfigMode() { configMode = true; }
void stopServers() {}
void recordBootStage(const char *) {}
void markIntentionalRestart(const char *) {}

#include "wifi_service_under_test.h"

int main() {
  fakeNow = 1001;
  // loop() sampled 1000 ms; handleClient() subsequently records 1001 ms.
  webServer.request = [] { lastConfigActivityMs = millis(); };
  serviceWifiStatus(1000);
  if (ESP.restarts || exits) {
    std::cerr << "FAIL: a page request triggered restart/config exit: restarts="
              << ESP.restarts << " exits=" << exits << '\n';
    return 1;
  }
  assert(lastConfigActivityMs == 1001);

  saveWifiCreds("new-network", " trailing space ");
  assert(wifiSsid == "new-network" && wifiPass == " trailing space ");
  wifiSsid.clear();

  webServer.request = [] { scanRunning = true; scanStartedMs = millis(); };
  serviceWifiStatus(1000);
  assert(scanRunning); // The same underflow must not end an asynchronous scan.

  webServer.request = nullptr;
  scanRunning = false;
  wifiSsid = "saved-network";
  lastConfigActivityMs = 1001;
  fakeNow = lastConfigActivityMs + CONFIG_SESSION_MS - 1;
  serviceWifiStatus(fakeNow);
  assert(configMode && ESP.restarts == 0 && exits == 0);
  fakeNow += 2;
  serviceWifiStatus(fakeNow);
  assert(!configMode && exits == 1 && connections == 1 && ESP.restarts == 0);

  configMode = true;
  lastConfigActivityMs = UINT32_MAX - 100;
  fakeNow = 150;
  serviceWifiStatus(fakeNow);
  assert(configMode && exits == 1); // Real millis() rollover remains valid.

  wifiConfigPending = true;
  wifiConfigApplyMs = fakeNow;
  wifiSsid = "new-network";
  serviceWifiStatus(fakeNow);
  assert(!configMode && !wifiConfigPending && connections == 2);
  std::cout << "firmware WiFi service: HTTP clock skew, scan clock skew, real idle timeout and clock rollover passed\n";
}
