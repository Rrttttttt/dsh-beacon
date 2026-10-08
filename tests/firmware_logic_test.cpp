#include <cassert>
#include <iostream>
#include <string>
#include "../v2.0/firmware/esp32c3_dsh_status_light/status_logic.h"

int main() {
  using namespace statuslight;
  RetryClock wifi;
  wifi.attempted(100);
  assert(wifi.next(200, 5000, 15000) == RetryAction::Wait);
  for (uint32_t now : {5100u, 10100u}) {
    assert(wifi.next(now, 5000, 15000) == RetryAction::Connect);
    wifi.attempted(now);
  }
  assert(wifi.next(15100, 5000, 15000) == RetryAction::Configure);
  wifi.connected();
  assert(wifi.next(16000, 5000, 15000) == RetryAction::Connect);
  wifi.attempted(UINT32_MAX - 99);
  assert(wifi.next(14900, 5000, 15000) == RetryAction::Configure);

  assert(jsonQuote(std::string("wifi-A")) == "\"wifi-A\"");
  assert(jsonQuote(std::string("a\"\\b\n\t")) == "\"a\\\"\\\\b\\u000a\\u0009\"");
  assert(jsonQuote(std::string("\xe7\xbd\x91\xe7\xbb\x9c")) == "\"\xe7\xbd\x91\xe7\xbb\x9c\"");
  assert(htmlEscape(std::string("<&\"'>")) == "&lt;&amp;&quot;&#39;&gt;");
  assert(isStateCommand(std::string("thinking+plan")));
  assert(!isStateCommand(std::string("wifi clear")));
  assert(!isStateCommand(std::string("power bod off")));

  Notification<std::string> notify;
  std::string restored;
  notify.begin("thinking", "success+plan", 10);
  assert(notify.stateChanged("error", "thinking"));
  assert(!notify.complete(1000, 600, restored));
  notify.begin("thinking", "", 1000);
  notify.begin("thinking", "", 1100);
  assert(!notify.complete(1600, 600, restored));
  assert(notify.complete(1700, 600, restored));
  assert(restored == "thinking");
  assert(notify.saved.empty() && notify.after.empty());
  notify.begin("thinking", "success", UINT32_MAX - 99);
  assert(notify.complete(500, 600, restored));
  assert(restored == "success");
  std::cout << "firmware logic: retry deadline, timer wrap, escaping, command validation and notification arbitration passed\n";
}
